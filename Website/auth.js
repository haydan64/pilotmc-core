const crypto = require('crypto');

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'pilotmc_session';
const STATE_COOKIE = 'pilotmc_oauth_state';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
const STATE_MAX_AGE_SECONDS = 60 * 10;

function getConfig() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_REDIRECT_URI || '',
    sessionSecret: process.env.SESSION_SECRET || process.env.DISCORD_OAUTH_SESSION_SECRET || ''
  };
}

function parseCookies(req) {
  const header = req.get('cookie') || '';
  return header.split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function seal(payload, secret) {
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

function unseal(value, secret) {
  if (!value || !secret) return null;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return null;
  const expected = sign(encoded, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  try {
    const payload = JSON.parse(fromBase64url(encoded));
    if (payload.expiresAt && Date.now() > payload.expiresAt) return null;
    return payload;
  } catch {
    return null;
  }
}

function getPublicBaseUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function getRedirectUri(req, config) {
  return config.redirectUri || `${getPublicBaseUrl(req)}/auth/discord/callback`;
}

function normalizeRedirect(value) {
  const raw = String(value || 'profile').trim();
  if (!raw || raw === 'profile') return '/profile';
  if (raw.startsWith('/')) return raw.startsWith('//') ? '/profile' : raw;
  return `/${raw.replace(/^\/+/, '')}`;
}

function cookieOptions(req, maxAgeSeconds) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  return {
    httpOnly: true,
    maxAge: maxAgeSeconds * 1000,
    path: '/',
    sameSite: 'lax',
    secure
  };
}

function clearCookieOptions(req) {
  return {
    ...cookieOptions(req, 0),
    maxAge: 0
  };
}

function getSession(req) {
  const config = getConfig();
  const cookies = parseCookies(req);
  return unseal(cookies[SESSION_COOKIE], config.sessionSecret);
}

function requireConfigured(config) {
  return config.clientId && config.clientSecret && config.sessionSecret;
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`Discord user lookup failed with HTTP ${response.status}`);
  return response.json();
}

async function exchangeCodeForToken(req, code, config) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: getRedirectUri(req, config)
  });

  const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Discord token exchange failed with HTTP ${response.status}`);
  }
  return payload;
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (session?.user?.id) {
    req.user = session.user;
    return next();
  }
  return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl.replace(/^\//, '') || 'profile')}`);
}

function registerAuthRoutes(app, Log) {
  app.set('trust proxy', true);

  app.get('/auth/discord/start', (req, res) => {
    const config = getConfig();
    if (!requireConfigured(config)) {
      Log.error('Auth', 'Discord OAuth is not configured. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and SESSION_SECRET.');
      return res.status(500).send('Discord OAuth is not configured.');
    }

    const redirect = normalizeRedirect(req.query.redirect);
    const state = {
      nonce: crypto.randomBytes(16).toString('base64url'),
      redirect,
      expiresAt: Date.now() + STATE_MAX_AGE_SECONDS * 1000
    };
    res.cookie(STATE_COOKIE, seal(state, config.sessionSecret), cookieOptions(req, STATE_MAX_AGE_SECONDS));

    const authUrl = new URL(`${DISCORD_API_BASE}/oauth2/authorize`);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', getRedirectUri(req, config));
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'identify');
    authUrl.searchParams.set('state', state.nonce);
    return res.redirect(authUrl.toString());
  });

  app.get('/auth/discord/callback', async (req, res, next) => {
    try {
      const config = getConfig();
      if (!requireConfigured(config)) return res.status(500).send('Discord OAuth is not configured.');

      const cookies = parseCookies(req);
      const state = unseal(cookies[STATE_COOKIE], config.sessionSecret);
      if (!state || state.nonce !== req.query.state) return res.status(400).send('Invalid OAuth state.');
      if (!req.query.code) return res.status(400).send('Missing OAuth code.');

      const token = await exchangeCodeForToken(req, req.query.code, config);
      const user = await fetchDiscordUser(token.access_token);

      const session = {
        user: {
          id: user.id,
          username: user.username,
          globalName: user.global_name || null,
          avatar: user.avatar || null
        },
        expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
      };
      res.cookie(SESSION_COOKIE, seal(session, config.sessionSecret), cookieOptions(req, SESSION_MAX_AGE_SECONDS));
      res.clearCookie(STATE_COOKIE, clearCookieOptions(req));
      Log.info('Auth', `Discord login userId=${user.id} username=${user.username}`);
      return res.redirect(state.redirect || '/profile');
    } catch (err) {
      return next(err);
    }
  });

  app.get('/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, clearCookieOptions(req));
    res.redirect('/');
  });
}

module.exports = {
  getSession,
  registerAuthRoutes,
  requireSession,
  normalizeRedirect
};
