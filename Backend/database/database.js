const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const connectionOptions = {
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'pilotmc_core',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
};

const pool = new Pool(connectionOptions);

async function query(text, params) {
  return pool.query(text, params);
}

async function close() {
  await pool.end();
}

async function healthCheck() {
  const result = await query('SELECT NOW() AS now, current_database() AS database;');
  return result.rows[0];
}

async function validateSchema() {
  const requiredTables = [
    'players',
    'player_applications',
    'player_application_responses',
    'service_agents',
    'audit_events'
  ];

  const result = await query(
    `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[]);
    `,
    [requiredTables]
  );
  const existingTables = new Set(result.rows.map((row) => row.table_name));
  const missingTables = requiredTables.filter((tableName) => !existingTables.has(tableName));

  if (missingTables.length) {
    throw new Error(`Missing required pilotmc_core tables: ${missingTables.join(', ')}`);
  }

  return { ok: true, tables: requiredTables };
}

function normalizePlayer(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    discordUserId: row.discord_user_id,
    minecraftUsername: row.minecraft_username,
    xuid: row.xuid,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeServiceAgent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    serviceName: row.service_name,
    serverKey: row.server_key,
    displayName: row.display_name,
    baseUrl: row.base_url,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeApplication(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    discordUserId: row.discord_user_id,
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewerDiscordUserId: row.reviewer_discord_user_id,
    denialReason: row.denial_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createAuditEvent({
  actorType = 'system',
  actorId = null,
  eventType,
  targetType = null,
  targetId = null,
  details = {}
}) {
  if (!eventType) throw new Error('eventType is required');

  const result = await query(
    `
    INSERT INTO audit_events (actor_type, actor_id, event_type, target_type, target_id, details)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    RETURNING *;
    `,
    [actorType, actorId, eventType, targetType, targetId, JSON.stringify(details || {})]
  );

  return result.rows[0];
}

async function upsertPlayerMinecraftUsername(discordUserId, minecraftUsername) {
  if (!discordUserId) throw new Error('discordUserId is required');
  if (!minecraftUsername) throw new Error('minecraftUsername is required');

  const result = await query(
    `
    INSERT INTO players (discord_user_id, minecraft_username)
    VALUES ($1, $2)
    ON CONFLICT (discord_user_id)
    DO UPDATE SET
      minecraft_username = EXCLUDED.minecraft_username,
      xuid = CASE
        WHEN LOWER(players.minecraft_username) <> LOWER(EXCLUDED.minecraft_username) THEN NULL
        ELSE players.xuid
      END,
      updated_at = NOW()
    RETURNING *;
    `,
    [discordUserId, minecraftUsername]
  );

  return normalizePlayer(result.rows[0]);
}

async function clearPlayerMinecraftUsername(discordUserId) {
  if (!discordUserId) throw new Error('discordUserId is required');

  const result = await query(
    `
    UPDATE players
    SET minecraft_username = NULL,
        xuid = NULL,
        updated_at = NOW()
    WHERE discord_user_id = $1
    RETURNING *;
    `,
    [discordUserId]
  );

  return normalizePlayer(result.rows[0]);
}

async function getPlayerByDiscordUserId(discordUserId) {
  if (!discordUserId) return null;
  const result = await query('SELECT * FROM players WHERE discord_user_id = $1;', [discordUserId]);
  return normalizePlayer(result.rows[0]);
}

async function getPlayerByMinecraftUsername(minecraftUsername) {
  if (!minecraftUsername) return null;
  const result = await query('SELECT * FROM players WHERE LOWER(minecraft_username) = LOWER($1);', [minecraftUsername]);
  return normalizePlayer(result.rows[0]);
}

async function getPlayerById(playerId) {
  if (!playerId) return null;
  const result = await query('SELECT * FROM players WHERE id = $1;', [playerId]);
  return normalizePlayer(result.rows[0]);
}

async function listPlayers() {
  const result = await query(
    `
    SELECT
      p.id,
      COALESCE(p.discord_user_id, pa.discord_user_id) AS discord_user_id,
      p.minecraft_username,
      p.xuid,
      COALESCE(p.created_at, pa.created_at) AS created_at,
      GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE(pa.updated_at, '-infinity'::timestamptz)
      ) AS updated_at,
      pa.status AS application_status,
      pa.submitted_at AS application_submitted_at,
      pa.reviewed_at AS application_reviewed_at
    FROM players p
    FULL OUTER JOIN player_applications pa ON pa.discord_user_id = p.discord_user_id
    ORDER BY COALESCE(p.created_at, pa.created_at) DESC, p.id DESC NULLS LAST;
    `
  );

  return result.rows.map((row) => ({
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    discordUserId: row.discord_user_id,
    minecraftUsername: row.minecraft_username,
    xuid: row.xuid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    application: {
      status: row.application_status || 'unsubmitted',
      submittedAt: row.application_submitted_at || null,
      reviewedAt: row.application_reviewed_at || null
    }
  }));
}

async function getApplicationByDiscordUserId(discordUserId) {
  if (!discordUserId) return null;
  const result = await query('SELECT * FROM player_applications WHERE discord_user_id = $1;', [discordUserId]);
  return normalizeApplication(result.rows[0]);
}

async function getApplicationResponsesByDiscordUserId(discordUserId) {
  if (!discordUserId) return [];
  const result = await query(
    `
    SELECT question_id, response, created_at, updated_at
    FROM player_application_responses
    WHERE discord_user_id = $1
    ORDER BY created_at;
    `,
    [discordUserId]
  );
  return result.rows.map((row) => ({
    questionId: row.question_id,
    response: row.response,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function getApplicationResponse(discordUserId, questionId) {
  if (!discordUserId || !questionId) return null;
  const result = await query(
    `
    SELECT question_id, response, created_at, updated_at
    FROM player_application_responses
    WHERE discord_user_id = $1 AND question_id = $2;
    `,
    [discordUserId, questionId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    questionId: row.question_id,
    response: row.response,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function saveApplicationResponse(discordUserId, questionId, response) {
  if (!discordUserId) throw new Error('discordUserId is required');
  if (!questionId) throw new Error('questionId is required');

  await query(
    `
    INSERT INTO player_applications (discord_user_id, status, updated_at)
    VALUES ($1, 'draft', NOW())
    ON CONFLICT (discord_user_id)
    DO UPDATE SET updated_at = NOW();
    `,
    [discordUserId]
  );

  const result = await query(
    `
    INSERT INTO player_application_responses (discord_user_id, question_id, response)
    VALUES ($1, $2, $3)
    ON CONFLICT (discord_user_id, question_id)
    DO UPDATE SET response = EXCLUDED.response, updated_at = NOW()
    RETURNING question_id, response, created_at, updated_at;
    `,
    [discordUserId, questionId, response]
  );

  const row = result.rows[0];
  return {
    questionId: row.question_id,
    response: row.response,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function deleteApplicationResponse(discordUserId, questionId) {
  if (!discordUserId) throw new Error('discordUserId is required');
  if (!questionId) throw new Error('questionId is required');
  const result = await query(
    `
    DELETE FROM player_application_responses
    WHERE discord_user_id = $1 AND question_id = $2
    RETURNING question_id, response, created_at, updated_at;
    `,
    [discordUserId, questionId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    questionId: row.question_id,
    response: row.response,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function setApplicationStatus(discordUserId, status, reviewerDiscordUserId = null, denialReason = null) {
  if (!discordUserId) throw new Error('discordUserId is required');
  if (!status) throw new Error('status is required');

  const result = await query(
    `
    INSERT INTO player_applications (
      discord_user_id,
      status,
      submitted_at,
      reviewed_at,
      reviewer_discord_user_id,
      denial_reason,
      updated_at
    )
    VALUES (
      $1,
      $2,
      CASE WHEN $2 = 'submitted' THEN NOW() ELSE NULL END,
      CASE WHEN $2 IN ('accepted', 'denied') THEN NOW() ELSE NULL END,
      CASE WHEN $2 IN ('accepted', 'denied') THEN $3 ELSE NULL END,
      CASE WHEN $2 = 'denied' THEN $4 ELSE NULL END,
      NOW()
    )
    ON CONFLICT (discord_user_id)
    DO UPDATE SET
      status = EXCLUDED.status,
      submitted_at = CASE
        WHEN EXCLUDED.status = 'submitted' THEN NOW()
        WHEN player_applications.submitted_at IS NULL AND EXCLUDED.status IN ('accepted', 'denied') THEN NOW()
        ELSE player_applications.submitted_at
      END,
      reviewed_at = CASE WHEN EXCLUDED.status IN ('accepted', 'denied') THEN NOW() ELSE NULL END,
      reviewer_discord_user_id = CASE WHEN EXCLUDED.status IN ('accepted', 'denied') THEN $3 ELSE NULL END,
      denial_reason = CASE WHEN EXCLUDED.status = 'denied' THEN $4 ELSE NULL END,
      updated_at = NOW()
    RETURNING *;
    `,
    [discordUserId, status, reviewerDiscordUserId, denialReason]
  );

  return normalizeApplication(result.rows[0]);
}

async function resetApplication(discordUserId) {
  if (!discordUserId) throw new Error('discordUserId is required');
  await query('DELETE FROM player_application_responses WHERE discord_user_id = $1;', [discordUserId]);
  const result = await query(
    `
    INSERT INTO player_applications (
      discord_user_id,
      status,
      submitted_at,
      reviewed_at,
      reviewer_discord_user_id,
      denial_reason,
      updated_at
    )
    VALUES ($1, 'draft', NULL, NULL, NULL, NULL, NOW())
    ON CONFLICT (discord_user_id)
    DO UPDATE SET
      status = 'draft',
      submitted_at = NULL,
      reviewed_at = NULL,
      reviewer_discord_user_id = NULL,
      denial_reason = NULL,
      updated_at = NOW()
    RETURNING *;
    `,
    [discordUserId]
  );
  return normalizeApplication(result.rows[0]);
}

async function saveDiscoveredXuid({ minecraftUsername, xuid, serverKey, actorId }) {
  if (!minecraftUsername) throw new Error('minecraftUsername is required');
  if (!xuid) throw new Error('xuid is required');

  const player = await getPlayerByMinecraftUsername(minecraftUsername);
  if (!player) {
    await createAuditEvent({
      actorType: 'service',
      actorId: actorId || serverKey || null,
      eventType: 'minecraft.xuid_unmatched',
      targetType: 'minecraft_username',
      targetId: minecraftUsername,
      details: { minecraftUsername, xuid, serverKey }
    });

    return {
      ok: false,
      status: 'not_found',
      message: `No global player exists for Minecraft username ${minecraftUsername}.`
    };
  }

  if (player.xuid && player.xuid !== xuid) {
    await createAuditEvent({
      actorType: 'service',
      actorId: actorId || serverKey || null,
      eventType: 'minecraft.xuid_conflict',
      targetType: 'player',
      targetId: String(player.id),
      details: {
        playerId: player.id,
        minecraftUsername,
        existingXuid: player.xuid,
        reportedXuid: xuid,
        serverKey
      }
    });

    return {
      ok: false,
      status: 'conflict',
      message: `XUID conflict for ${minecraftUsername}.`,
      player,
      existingXuid: player.xuid,
      reportedXuid: xuid
    };
  }

  if (player.xuid === xuid) {
    return {
      ok: true,
      status: 'unchanged',
      message: `XUID already known for ${minecraftUsername}.`,
      player
    };
  }

  const result = await query(
    `
    UPDATE players
    SET xuid = $2, updated_at = NOW()
    WHERE id = $1
    RETURNING *;
    `,
    [player.id, xuid]
  );

  const updatedPlayer = normalizePlayer(result.rows[0]);
  await createAuditEvent({
    actorType: 'service',
    actorId: actorId || serverKey || null,
    eventType: 'minecraft.xuid_discovered',
    targetType: 'player',
    targetId: String(updatedPlayer.id),
    details: { playerId: updatedPlayer.id, minecraftUsername, xuid, serverKey }
  });

  return {
    ok: true,
    status: 'updated',
    message: `Saved XUID for ${minecraftUsername}.`,
    player: updatedPlayer
  };
}

async function listServiceAgents() {
  const result = await query('SELECT * FROM service_agents ORDER BY service_name;');
  return result.rows.map(normalizeServiceAgent);
}

async function getServiceAgentByServerKey(serverKey) {
  if (!serverKey) return null;
  const result = await query(
    'SELECT * FROM service_agents WHERE server_key = $1 AND enabled = TRUE;',
    [serverKey]
  );
  return normalizeServiceAgent(result.rows[0]);
}

module.exports = {
  pool,
  query,
  close,
  healthCheck,
  validateSchema,
  createAuditEvent,
  upsertPlayerMinecraftUsername,
  clearPlayerMinecraftUsername,
  getPlayerByDiscordUserId,
  getPlayerByMinecraftUsername,
  getPlayerById,
  listPlayers,
  getApplicationByDiscordUserId,
  getApplicationResponsesByDiscordUserId,
  getApplicationResponse,
  saveApplicationResponse,
  deleteApplicationResponse,
  setApplicationStatus,
  resetApplication,
  saveDiscoveredXuid,
  listServiceAgents,
  getServiceAgentByServerKey
};
