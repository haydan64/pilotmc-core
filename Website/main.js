const express = require('express');
const path = require('path');
const Log = require('./log');
const { getSession, normalizeRedirect, registerAuthRoutes, requireSession } = require('./auth');
const { escapeHtml, renderTemplate } = require('./template');
const { loadModules } = require('./moduleLoader');
const { registerAdminRoutes } = require('./adminRoutes');
require('dotenv').config();

const PORT = Number(process.env.PORT || 3001);
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
const BACKEND_API_TOKEN = process.env.BACKEND_API_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.WEBSITE_PUBLIC_URL || '';
const SITE_NAME = String(process.env.SITE_NAME || 'PilotMC').trim() || 'PilotMC';
const SITE_SHORT_NAME = String(process.env.SITE_SHORT_NAME || SITE_NAME).trim() || SITE_NAME;
const SITE_DESCRIPTION = String(
  process.env.SITE_DESCRIPTION ||
  'A configurable platform for operating Minecraft Bedrock servers, connecting Discord communities, and managing player identities.'
).trim();
const SITE_LOGO_PATH = String(process.env.SITE_LOGO_PATH || '').trim();
const SITE_FAVICON_PATH = String(process.env.SITE_FAVICON_PATH || '').trim();
const STARTED_AT = new Date();
const app = express();
const publicDir = path.join(__dirname, 'public');
const privateDir = path.join(__dirname, 'private');

app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    const durationMs = Date.now() - startedAt;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    Log[level]('HTTP', `${req.ip} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`);
  });
  next();
});

loadModules({ app, publicDir }).catch((err) => {
  Log.error('Module Loader', 'Failed to load modules', err);
});
registerAuthRoutes(app, Log);

async function backendJson(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (BACKEND_API_TOKEN) headers.Authorization = `Bearer ${BACKEND_API_TOKEN}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (options.actor) {
    headers['X-Actor-Type'] = 'discord_user';
    headers['X-Actor-Id'] = options.actor.id;
  }

  const response = await fetch(new URL(path, BACKEND_URL), {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload.error || `Backend returned HTTP ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }
  return payload;
}

function fetchBackendJson(path) {
  return backendJson(path);
}

function sendBackendJson(path, options = {}) {
  return backendJson(path, options);
}

async function checkAdminAccess(discordUserId) {
  if (!discordUserId) return { allowed: false, reason: 'missing_user' };
  try {
    const result = await fetchBackendJson(`/api/discord/users/${encodeURIComponent(discordUserId)}/admin`);
    return {
      allowed: Boolean(result.allowed),
      reason: result.reason || null
    };
  } catch (err) {
    Log.warn('Admin', `Admin role check failed for userId=${discordUserId}: ${err.message}`);
    return { allowed: false, reason: 'role_check_failed' };
  }
}

function siteTemplateValues() {
  return {
    siteName: SITE_NAME,
    siteShortName: SITE_SHORT_NAME,
    siteDescription: SITE_DESCRIPTION,
    brandLogo: SITE_LOGO_PATH
      ? `<img class="brand-logo" src="/assets/brand-logo.png" alt="${escapeHtml(SITE_NAME)} logo">`
      : ''
  };
}

function sendConfiguredAsset(res, configuredPath) {
  if (!configuredPath) return res.sendStatus(404);
  return res.sendFile(path.resolve(configuredPath), (err) => {
    if (err && !res.headersSent) res.sendStatus(err.statusCode || 404);
  });
}

function adminLinkHtml(isAdmin) {
  return isAdmin ? '<a class="nav-button secondary" href="/admin">Admin</a>' : '';
}

function discordWidgetHtml() {
  const guildId = String(process.env.DISCORD_GUILD_ID || '').trim();
  if (!/^\d{16,20}$/.test(guildId)) return '';
  return `<iframe src="https://discord.com/widget?id=${guildId}&theme=dark" width="350" height="500" allowtransparency="true" frameborder="0" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>`;
}

app.get('/assets/brand-logo.png', (req, res) => sendConfiguredAsset(res, SITE_LOGO_PATH));
app.get('/favicon.ico', (req, res) => sendConfiguredAsset(res, SITE_FAVICON_PATH));

registerAdminRoutes({
  app,
  privateDir,
  requireSession,
  checkAdminAccess,
  fetchBackendJson,
  sendBackendJson,
  renderTemplate,
  Log,
  config: {
    publicUrl: PUBLIC_URL,
    startedAt: STARTED_AT.toISOString(),
    siteTemplateValues
  }
});

app.get('/', async (req, res) => {
  const session = getSession(req);
  const user = session?.user || null;
  const adminAccess = user?.id ? await checkAdminAccess(user.id) : { allowed: false };
  res.setHeader('Cache-Control', 'no-store');
  res.send(renderTemplate(path.join(publicDir, 'index.html'), {
    ...siteTemplateValues(),
    authHref: user ? '/profile' : '/login?redirect=profile',
    authLabel: user ? 'Profile' : 'Log in with Discord',
    heroAction: user ? 'View Profile' : 'Log in with Discord',
    adminLink: adminLinkHtml(adminAccess.allowed),
    discordWidget: discordWidgetHtml()
  }));
});

app.get('/login', (req, res) => {
  const redirect = normalizeRedirect(req.query.redirect);
  res.setHeader('Cache-Control', 'no-store');
  res.send(renderTemplate(path.join(publicDir, 'login', 'index.html'), {
    ...siteTemplateValues(),
    oauthHref: `/auth/discord/start?redirect=${encodeURIComponent(redirect)}`
  }));
});

app.get('/profile', requireSession, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const profile = await fetchBackendJson(`/api/players/discord/${encodeURIComponent(req.user.id)}/profile`);
    const adminAccess = await checkAdminAccess(req.user.id);
    const player = profile.player || {};
    const application = profile.application || {};

    res.send(renderTemplate(path.join(privateDir, 'profile', 'index.html'), {
      ...siteTemplateValues(),
      displayName: req.user.globalName || req.user.username,
      discordUsername: req.user.username,
      discordUserId: req.user.id,
      applicationStatus: application.status || 'unsubmitted',
      minecraftUsername: player.minecraftUsername || 'Not linked yet',
      xuid: player.xuid || 'Not discovered yet',
      adminLink: adminLinkHtml(adminAccess.allowed)
    }));
  } catch (err) {
    Log.warn('Profile', `Unable to load profile for userId=${req.user.id}: ${err.message}`);
    res.status(err.statusCode || 500).send(renderTemplate(path.join(privateDir, 'profile', 'error.html'), {
      ...siteTemplateValues(),
      message: err.message || 'Profile unavailable.'
    }));
  }
});

app.use((req, res) => {
  const session = getSession(req);
  if (!session?.user?.id) return res.redirect('/');
  return res.redirect('/profile');
});

app.use((err, req, res, next) => {
  Log.error('HTTP', 'Request failed:', err);
  res.status(err.statusCode || 500).send('Internal server error');
});

app.listen(PORT, () => {
  Log.info('Website', `pilotmc-website listening on :${PORT}`);
});

process.on('uncaughtException', (err) => {
  Log.error('Website', 'Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  Log.error('Website', 'Unhandled rejection:', reason);
});
