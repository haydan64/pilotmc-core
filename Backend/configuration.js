const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { schema, assertConfig, project, defaults } = require('../configuration/schema');
function safeEqual(a, b) { const left = Buffer.from(a || ''); const right = Buffer.from(b || ''); return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right); }
function createConfigStore(database) {
  return {
    async initialize(seed) {
      const existing = await database.query("SELECT to_regclass('deployment_configuration') AS config,to_regclass('deployment_configuration_history') AS history,to_regclass('configuration_service_status') AS status");
      if (!existing.rows[0]?.config || !existing.rows[0]?.history || !existing.rows[0]?.status) throw new Error('Central configuration tables are missing. Apply Backend/database/migrations/001-central-configuration.sql with a database administrator before starting Backend.');
      if ((await database.query('SELECT id FROM deployment_configuration WHERE id=1')).rows.length) return;
      const initial = assertConfig((typeof seed === 'function' ? seed() : seed) || defaults());
      await database.query('INSERT INTO deployment_configuration(id,revision,config,updated_by) VALUES(1,1,$1,\'bootstrap\') ON CONFLICT(id) DO NOTHING', [JSON.stringify(initial)]);
      await database.query('INSERT INTO deployment_configuration_history SELECT revision,config,updated_at,updated_by FROM deployment_configuration ON CONFLICT(revision) DO NOTHING');
    },
    async read() { const { rows } = await database.query('SELECT revision,config,updated_at AS "updatedAt",updated_by AS "updatedBy" FROM deployment_configuration WHERE id=1'); if (!rows[0]) throw new Error('Central configuration is not initialized'); return rows[0]; },
    async save(config, expectedRevision, actor) {
      assertConfig(config);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) { const err = new Error('A valid expected revision is required'); err.statusCode = 400; throw err; }
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('UPDATE deployment_configuration SET config=$1, revision=revision+1, updated_at=NOW(), updated_by=$2 WHERE id=1 AND revision=$3 RETURNING revision,config,updated_at AS "updatedAt",updated_by AS "updatedBy"', [JSON.stringify(config), actor, expectedRevision]);
        if (!rows[0]) { const err = new Error('Configuration changed since you loaded it. Reload before saving.'); err.statusCode = 409; throw err; }
        await client.query('INSERT INTO deployment_configuration_history SELECT revision,config,updated_at,updated_by FROM deployment_configuration');
        await client.query('INSERT INTO audit_events(actor_type,actor_id,event_type,target_type,target_id,details) VALUES(\'discord_user\',$1,\'configuration.saved\',\'deployment_configuration\',\'1\',$2)', [actor, JSON.stringify({ revision: rows[0].revision })]);
        await client.query('COMMIT'); return rows[0];
      } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    },
    async report(serviceId, active, fetched) { await database.query('INSERT INTO configuration_service_status(service_id,active_revision,fetched_revision) VALUES($1,$2,$3) ON CONFLICT(service_id) DO UPDATE SET active_revision=$2,fetched_revision=$3,last_seen=NOW()', [serviceId, active, fetched]); },
    async statuses() { return (await database.query('SELECT service_id AS "serviceId",active_revision AS "activeRevision",fetched_revision AS "fetchedRevision",last_seen AS "lastSeen" FROM configuration_service_status ORDER BY service_id')).rows; },
    async revision(revision) { return (await database.query('SELECT config FROM deployment_configuration_history WHERE revision=$1', [revision])).rows[0]?.config; },
    async history() { return (await database.query('SELECT revision,updated_at AS "updatedAt",updated_by AS "updatedBy" FROM deployment_configuration_history ORDER BY revision DESC LIMIT 25')).rows; }
  };
}
function registerConfigurationRoutes({ app, store, requireApiToken, asyncRoute, requestDiscordAdminCheck }) {
  async function admin(req) {
    const tokens = JSON.parse(process.env.CONFIG_SERVICE_TOKENS || '{}');
    if (!safeEqual(req.get('x-config-service-token'), tokens.website)) { const err = new Error('Website configuration credential required'); err.statusCode = 403; throw err; }
    const actor = req.get('x-actor-id');
    if (!actor || !(await requestDiscordAdminCheck(actor)).allowed) { const err = new Error('Administrator access required'); err.statusCode = 403; throw err; }
    return actor;
  }
  app.get('/api/admin/configuration', requireApiToken, asyncRoute(async (req, res) => { await admin(req); res.set('Cache-Control','no-store'); res.json({ ok: true, ...await store.read(), schema, services: await store.statuses(), history: await store.history() }); }));
  app.get('/api/admin/configuration/history/:revision', requireApiToken, asyncRoute(async (req, res) => {
    await admin(req);
    const revision = Number(req.params.revision);
    if (!Number.isInteger(revision) || revision < 1) return res.status(400).json({ ok: false, error: 'Invalid revision' });
    const config = await store.revision(revision);
    if (!config) return res.status(404).json({ ok: false, error: 'Revision not found' });
    res.set('Cache-Control', 'no-store'); res.json({ ok: true, config });
  }));
  app.put('/api/admin/configuration', requireApiToken, asyncRoute(async (req, res) => {
    const actor = await admin(req); const existing = await store.read();
    if (existing.config.discord.roles.admin && !req.body?.config?.discord?.roles?.admin) { const err = new Error('Keep an administrator role configured'); err.statusCode = 400; throw err; }
    res.json({ ok: true, ...await store.save(req.body?.config, req.body?.expectedRevision, actor) });
  }));
  app.get('/api/configuration/:service', asyncRoute(async (req, res) => {
    const service = req.params.service; const key = req.query.serverKey;
    const serviceId = service === 'instance' ? `instance:${key}` : service;
    const tokens = JSON.parse(process.env.CONFIG_SERVICE_TOKENS || '{}');
    if (!['discord','website','instance'].includes(service) || !safeEqual(req.get('authorization')?.replace(/^Bearer /,''), tokens[serviceId])) return res.status(401).json({ ok: false, error: 'Unauthorized configuration service' });
    const snapshot = await store.read();
    const config = project(snapshot.config, service, key);
    const active = Number(req.query.activeRevision || 0);
    if (!Number.isInteger(active) || active < 0 || active > snapshot.revision) return res.status(400).json({ ok: false, error: 'Invalid active revision' });
    await store.report(serviceId, active, snapshot.revision);
    res.set('Cache-Control','no-store'); res.json({ ok: true, serviceId, revision: snapshot.revision, config });
  }));
}
function readSeed() { const file = process.env.CONFIG_INITIAL_FILE || path.join(__dirname, '..', 'config.initial.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; }
module.exports = { createConfigStore, registerConfigurationRoutes, readSeed, safeEqual };
