const path = require('path');

function jsonError(res, err) {
  return res.status(err.statusCode || 500).json({
    ok: false,
    error: err.message || 'Request failed'
  });
}

function quoteBedrockName(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function registerAdminRoutes({
  app,
  privateDir,
  requireSession,
  checkAdminAccess,
  fetchBackendJson,
  sendBackendJson,
  renderTemplate,
  Log,
  config
}) {
  async function requireAdmin(req, res, next) {
    requireSession(req, res, async () => {
      try {
        const access = await checkAdminAccess(req.user.id);
        if (!access.allowed) {
          Log.warn('Admin', `Denied admin access userId=${req.user.id} reason=${access.reason || 'unknown'}`);
          if (req.path.startsWith('/api/')) {
            return res.status(403).json({ ok: false, error: 'Admin access required.' });
          }
          return res.redirect('/profile');
        }
        req.adminAccess = access;
        return next();
      } catch (err) {
        return next(err);
      }
    });
  }

  app.use('/admin', requireAdmin);

  app.get('/admin', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderTemplate(path.join(privateDir, 'admin', 'index.html'), {
      displayName: req.user.globalName || req.user.username
    }));
  });

  app.get('/admin/api/general', async (req, res) => {
    try {
      const backend = await fetchBackendJson('/api/admin/backend/status').catch((err) => ({
        ok: false,
        error: err.message
      }));
      res.json({
        ok: true,
        website: {
          service: 'pilotmc-website',
          publicUrl: config.publicUrl || null,
          backendConnected: Boolean(backend.ok),
          auth: 'Discord OAuth',
          startedAt: config.startedAt,
          uptimeSeconds: Math.floor(process.uptime())
        },
        backend
      });
    } catch (err) {
      jsonError(res, err);
    }
  });

  app.get('/admin/api/backend', async (req, res) => {
    try {
      res.json(await fetchBackendJson('/api/admin/backend/status'));
    } catch (err) {
      jsonError(res, err);
    }
  });

  app.get('/admin/api/discord', async (req, res) => {
    try {
      res.json(await fetchBackendJson('/api/admin/discord/status'));
    } catch (err) {
      jsonError(res, err);
    }
  });

  app.get('/admin/api/minecraft', async (req, res) => {
    try {
      res.json(await fetchBackendJson('/api/admin/minecraft'));
    } catch (err) {
      jsonError(res, err);
    }
  });

  app.get('/admin/api/minecraft/:serverKey', async (req, res) => {
    try {
      res.json(await fetchBackendJson(`/api/admin/minecraft/${encodeURIComponent(req.params.serverKey)}`));
    } catch (err) {
      jsonError(res, err);
    }
  });

  app.post('/admin/api/minecraft/:serverKey/player/:username/action', async (req, res) => {
    try {
      const serverKey = req.params.serverKey;
      const username = req.params.username;
      const action = String(req.body?.action || '').trim();
      if (!action) return res.status(400).json({ ok: false, error: 'Action is required.' });

      if (action === 'inventory') {
        const result = await sendBackendJson(`/api/servers/${encodeURIComponent(serverKey)}/commands`, {
          method: 'POST',
          actor: req.user,
          body: { action: 'inventory:get', username }
        });
        const liveResult = result?.result?.result;
        if (!liveResult?.ok) {
          return res.status(502).json({ ok: false, error: liveResult?.message || 'Unable to load live inventory.' });
        }
        return res.json({ ok: true, inventory: liveResult.data?.inventory || [], enderChest: liveResult.data?.enderChest || [] });
      }

      if (action === 'unwhitelist') {
        const player = await fetchBackendJson(`/api/players/minecraft/${encodeURIComponent(username)}`);
        const result = await sendBackendJson(
          `/api/servers/${encodeURIComponent(serverKey)}/allowlist/${encodeURIComponent(player.player.id)}`,
          {
            method: 'DELETE',
            actor: req.user
          }
        );
        return res.json(result);
      }

      if (action === 'kick') {
        const reason = String(req.body?.reason || 'Removed by staff.').trim();
        const result = await sendBackendJson(`/api/servers/${encodeURIComponent(serverKey)}/commands`, {
          method: 'POST',
          actor: req.user,
          body: {
            action: 'command',
            command: `kick ${quoteBedrockName(username)} ${reason}`
          }
        });
        return res.json(result);
      }

      if (action === 'message') {
        const message = String(req.body?.message || '').trim();
        if (!message) return res.status(400).json({ ok: false, error: 'Message is required.' });
        const tellraw = {
          rawtext: [{ text: message }]
        };
        const result = await sendBackendJson(`/api/servers/${encodeURIComponent(serverKey)}/commands`, {
          method: 'POST',
          actor: req.user,
          body: {
            action: 'command',
            command: `tellraw ${quoteBedrockName(username)} ${JSON.stringify(tellraw)}`
          }
        });
        return res.json(result);
      }

      return res.status(400).json({ ok: false, error: 'Unknown player action.' });
    } catch (err) {
      jsonError(res, err);
    }
  });

  app.get('/admin/api/users', async (req, res) => {
    try {
      res.json(await fetchBackendJson('/api/admin/users'));
    } catch (err) {
      jsonError(res, err);
    }
  });

  app.get('/admin/api/users/:discordUserId', async (req, res) => {
    try {
      const discordUserId = encodeURIComponent(req.params.discordUserId);
      const [profile, application] = await Promise.all([
        fetchBackendJson(`/api/players/discord/${discordUserId}/profile`).catch((err) => ({ ok: false, error: err.message })),
        fetchBackendJson(`/api/applications/discord/${discordUserId}`).catch((err) => ({ ok: false, error: err.message }))
      ]);
      res.json({ ok: true, profile, application });
    } catch (err) {
      jsonError(res, err);
    }
  });

  app.post('/admin/api/users/:discordUserId/reset-application', async (req, res) => {
    try {
      const result = await sendBackendJson(`/api/applications/discord/${encodeURIComponent(req.params.discordUserId)}/reset`, {
        method: 'POST',
        actor: req.user,
        body: {}
      });
      res.json(result);
    } catch (err) {
      jsonError(res, err);
    }
  });
}

module.exports = {
  registerAdminRoutes
};
