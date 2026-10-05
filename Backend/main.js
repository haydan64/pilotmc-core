const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const database = require('./database/database');
const Log = require('./log');
const { loadModules } = require('./moduleLoader');
const { createConfigStore, registerConfigurationRoutes, readSeed } = require('./configuration');
const configurationStore = createConfigStore(database);
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, 'database', '.env') });

const PORT = Number(process.env.PORT || 3000);
const API_TOKEN = process.env.BACKEND_API_TOKEN || '';
let AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 10000);
let DISCORD_AUTH_TIMEOUT_MS = Number(process.env.DISCORD_AUTH_TIMEOUT_MS || 5000);
const STARTED_AT = new Date();
const BUILD_MARKER = 'socket-ack-relay-2026-06-28';
const MINECRAFT_EVENT_HANDLER_MARKER = 'minecraft-event-handler-v2';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.SOCKET_IO_CORS_ORIGIN || '*'
  }
});
const SERVER_ACTIONS = new Set(['start', 'stop', 'forceStop', 'restart', 'reload', 'backup', 'backupCleanup:set', 'inventory:get', 'update', 'permission:set']);
const socketRelayEvents = [];
const latestServerStatus = new Map();
const latestServerPlayers = new Map();
const latestMinecraftPlayerLists = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const role = socket.handshake.auth?.role;
  if (!API_TOKEN || token !== API_TOKEN) {
    Log.warn('Socket Auth', `Rejected unauthenticated socket role=${role || 'unknown'}.`);
    return next(new Error('Unauthorized'));
  }
  if (!['discord', 'minecraft-agent'].includes(role)) {
    Log.warn('Socket Auth', `Rejected unsupported socket role=${role || 'unknown'}.`);
    return next(new Error('Unauthorized'));
  }
  if (role === 'minecraft-agent' && !socket.handshake.auth?.serverKey) {
    return next(new Error('serverKey is required'));
  }
  return next();
});

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const origin = req.get('origin');
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Token,X-Actor-Type,X-Actor-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

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

loadModules({ app, server, io, database }).catch((err) => {
  Log.error('Module Loader', 'Failed to load modules', err);
});

function requireApiToken(req, res, next) {
  if (!API_TOKEN) {
    Log.error('Auth', 'BACKEND_API_TOKEN is not configured; protected API access is disabled.');
    return res.status(503).json({ ok: false, error: 'Backend authentication is not configured.' });
  }

  const auth = req.get('authorization') || '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  const provided = bearerToken || req.get('x-api-token');

  if (provided !== API_TOKEN) {
    Log.warn('Auth', `Unauthorized request from ${req.ip}: ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  return next();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireString(value, fieldName) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    const err = new Error(`${fieldName} is required`);
    err.statusCode = 400;
    throw err;
  }
  return normalized;
}

function getActor(req, fallbackType = 'system') {
  return {
    actorType: req.get('x-actor-type') || fallbackType,
    actorId: req.get('x-actor-id') || null
  };
}

function rememberSocketRelayEvent(type, payload = {}) {
  socketRelayEvents.push({
    type,
    role: payload.role || null,
    serverKey: payload.serverKey || null,
    event: payload.event || null,
    socketId: payload.socketId || null,
    at: new Date().toISOString()
  });
  if (socketRelayEvents.length > 50) socketRelayEvents.shift();
}

function rememberServerStatus(payload = {}) {
  const key = payload.serverKey || payload.server || null;
  if (!key) return;
  latestServerStatus.set(key, {
    ...payload,
    receivedAt: new Date().toISOString()
  });
}

function normalizePlayerListPayload(payload = {}) {
  const content = payload.content || {};
  const players = Array.isArray(content)
    ? content
    : Array.isArray(content.players)
      ? content.players
      : Array.isArray(payload.players)
        ? payload.players
        : [];
  return players.map(({ inventory, enderChest, ...player }) => player);
}

function rememberServerPlayers(payload = {}) {
  const key = payload.serverKey || payload.server || null;
  if (!key) return;
  latestServerPlayers.set(key, {
    players: normalizePlayerListPayload(payload),
    raw: payload,
    receivedAt: new Date().toISOString()
  });
}

function rememberMinecraftPlayerList(payload = {}) {
  if (payload.event !== 'playerList') return;
  const key = payload.serverKey || payload.server || null;
  if (!key) return;
  latestMinecraftPlayerLists.set(key, {
    players: normalizePlayerListPayload(payload),
    raw: payload,
    receivedAt: new Date().toISOString()
  });
}

function requestDiscordEvent(eventName, payload = {}, timeoutMs = DISCORD_AUTH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    io.to('discord').timeout(timeoutMs).emit(eventName, payload, (err, responses = []) => {
      if (err && !responses.length) {
        const unavailableErr = new Error('Discord bot is unavailable.');
        unavailableErr.statusCode = 503;
        reject(unavailableErr);
        return;
      }

      const normalizedResponses = responses.filter((entry) => entry && typeof entry === 'object');
      const success = normalizedResponses.find((entry) => entry.ok);
      const failure = normalizedResponses.find((entry) => entry.ok === false);
      if (success) return resolve(success);

      const responseErr = new Error(failure?.error || 'Discord bot did not return a usable response.');
      responseErr.statusCode = failure?.statusCode || 503;
      return reject(responseErr);
    });
  });
}

async function fetchAgent(serverKey, path, options = {}) {
  const agent = await database.getServiceAgentByServerKey(serverKey);
  if (!agent?.baseUrl) {
    const err = new Error(`No enabled service agent is configured for server ${serverKey}.`);
    err.statusCode = 404;
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  const url = new URL(path, agent.baseUrl.endsWith('/') ? agent.baseUrl : `${agent.baseUrl}/`);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_TOKEN}`,
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (!response.ok) {
      const err = new Error(body?.error || body?.message || `Agent returned HTTP ${response.status}`);
      err.statusCode = response.status;
      err.agentResponse = body;
      throw err;
    }

    return {
      agent,
      response: body
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Timed out contacting ${agent.serviceName}.`);
      timeoutErr.statusCode = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function requestDiscordAdminCheck(discordUserId) {
  return new Promise((resolve, reject) => {
    io.to('discord').timeout(DISCORD_AUTH_TIMEOUT_MS).emit(
      'discord:checkAdmin',
      { discordUserId },
      (err, responses = []) => {
        if (err && !responses.length) {
          const unavailableErr = new Error('Discord bot is unavailable for role checks.');
          unavailableErr.statusCode = 503;
          reject(unavailableErr);
          return;
        }

        const normalizedResponses = responses.filter((entry) => entry && typeof entry === 'object');
        const failedResponse = normalizedResponses.find((entry) => entry.ok === false);
        const allowedResponse = normalizedResponses.find((entry) => entry.ok && entry.allowed);
        const deniedResponse = normalizedResponses.find((entry) => entry.ok && !entry.allowed);

        if (allowedResponse) {
          resolve(allowedResponse);
          return;
        }

        if (deniedResponse) {
          resolve(deniedResponse);
          return;
        }

        const message = failedResponse?.error || 'Discord bot did not return a usable role check.';
        const roleErr = new Error(message);
        roleErr.statusCode = failedResponse?.statusCode || 503;
        reject(roleErr);
      }
    );
  });
}

app.get('/health', asyncRoute(async (req, res) => {
  const databaseHealth = await database.healthCheck();
  res.json({
    ok: true,
    service: 'pilotmc-backend',
    database: databaseHealth.database,
    checkedAt: databaseHealth.now
  });
}));

app.get('/api/players/discord/:discordUserId', requireApiToken, asyncRoute(async (req, res) => {
  const player = await database.getPlayerByDiscordUserId(req.params.discordUserId);
  if (!player) return res.status(404).json({ ok: false, error: 'Player not found' });
  return res.json({ ok: true, player });
}));

app.get('/api/players/discord/:discordUserId/profile', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const player = await database.getPlayerByDiscordUserId(discordUserId);
  const application = await database.getApplicationByDiscordUserId(discordUserId);
  const agents = await database.listServiceAgents();
  const servers = [];

  for (const agent of agents.filter((entry) => entry.enabled && entry.serverKey)) {
    if (!player?.id) {
      servers.push({
        serverKey: agent.serverKey,
        displayName: agent.displayName,
        available: true,
        profile: null
      });
      continue;
    }

    try {
      const { response } = await fetchAgent(
        agent.serverKey,
        `/api/players/${encodeURIComponent(player.id)}/profile`,
        { method: 'GET' }
      );
      servers.push({
        serverKey: agent.serverKey,
        displayName: agent.displayName,
        available: true,
        profile: response?.profile || null
      });
    } catch (err) {
      servers.push({
        serverKey: agent.serverKey,
        displayName: agent.displayName,
        available: false,
        error: err.message
      });
    }
  }

  res.json({
    ok: true,
    player,
    application: application || { status: 'unsubmitted' },
    servers
  });
}));

app.get('/api/applications/discord/:discordUserId', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const application = await database.getApplicationByDiscordUserId(discordUserId);
  const responses = await database.getApplicationResponsesByDiscordUserId(discordUserId);
  res.json({
    ok: true,
    application: application || { discordUserId, status: 'unsubmitted' },
    responses
  });
}));

app.get('/api/applications/discord/:discordUserId/responses/:questionId', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const questionId = requireString(req.params.questionId, 'questionId');
  const response = await database.getApplicationResponse(discordUserId, questionId);
  if (!response) return res.status(404).json({ ok: false, error: 'Application response not found' });
  res.json({ ok: true, response });
}));

app.put('/api/applications/discord/:discordUserId/responses/:questionId', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const questionId = requireString(req.params.questionId, 'questionId');
  const responseText = requireString(req.body?.response, 'response');
  const actor = getActor(req, 'discord_user');
  const response = await database.saveApplicationResponse(discordUserId, questionId, responseText);

  await database.createAuditEvent({
    ...actor,
    eventType: 'player.application_response_saved',
    targetType: 'discord_user',
    targetId: discordUserId,
    details: { discordUserId, questionId }
  });

  res.json({ ok: true, response });
}));

app.delete('/api/applications/discord/:discordUserId/responses/:questionId', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const questionId = requireString(req.params.questionId, 'questionId');
  const actor = getActor(req, 'discord_user');
  const response = await database.deleteApplicationResponse(discordUserId, questionId);

  await database.createAuditEvent({
    ...actor,
    eventType: 'player.application_response_deleted',
    targetType: 'discord_user',
    targetId: discordUserId,
    details: { discordUserId, questionId }
  });

  res.json({ ok: true, response });
}));

app.put('/api/applications/discord/:discordUserId/status', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const status = requireString(req.body?.status, 'status');
  const reviewerDiscordUserId = req.body?.reviewerDiscordUserId ? String(req.body.reviewerDiscordUserId).trim() : null;
  const denialReason = req.body?.denialReason ? String(req.body.denialReason).trim() : null;
  const actor = getActor(req, 'discord_user');
  const application = await database.setApplicationStatus(discordUserId, status, reviewerDiscordUserId, denialReason);

  await database.createAuditEvent({
    ...actor,
    eventType: 'player.application_status_set',
    targetType: 'discord_user',
    targetId: discordUserId,
    details: { discordUserId, status, reviewerDiscordUserId, denialReason }
  });

  res.json({ ok: true, application });
}));

app.post('/api/applications/discord/:discordUserId/reset', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const actor = getActor(req, 'discord_user');
  const application = await database.resetApplication(discordUserId);

  await database.createAuditEvent({
    ...actor,
    eventType: 'player.application_reset',
    targetType: 'discord_user',
    targetId: discordUserId,
    details: { discordUserId }
  });

  res.json({ ok: true, application });
}));

app.get('/api/players/minecraft/:minecraftUsername', requireApiToken, asyncRoute(async (req, res) => {
  const player = await database.getPlayerByMinecraftUsername(req.params.minecraftUsername);
  if (!player) return res.status(404).json({ ok: false, error: 'Player not found' });
  return res.json({ ok: true, player });
}));

app.put('/api/players/discord/:discordUserId/minecraft-username', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const minecraftUsername = requireString(req.body?.minecraftUsername, 'minecraftUsername');
  const actor = getActor(req, 'discord_user');

  const player = await database.upsertPlayerMinecraftUsername(discordUserId, minecraftUsername);
  await database.createAuditEvent({
    ...actor,
    eventType: 'player.minecraft_username_set',
    targetType: 'player',
    targetId: String(player.id),
    details: { discordUserId, minecraftUsername }
  });

  io.to('admin').emit('admin:event', {
    type: 'player.minecraft_username_set',
    player
  });

  res.json({ ok: true, player });
}));

app.delete('/api/players/discord/:discordUserId/minecraft-username', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const actor = getActor(req, 'discord_user');
  const previousPlayer = await database.getPlayerByDiscordUserId(discordUserId);
  if (!previousPlayer) return res.status(404).json({ ok: false, error: 'Player not found' });

  const player = await database.clearPlayerMinecraftUsername(discordUserId);
  await database.createAuditEvent({
    ...actor,
    eventType: 'player.minecraft_username_removed',
    targetType: 'player',
    targetId: String(previousPlayer.id),
    details: {
      discordUserId,
      previousMinecraftUsername: previousPlayer.minecraftUsername,
      previousXuid: previousPlayer.xuid
    }
  });

  io.to('admin').emit('admin:event', {
    type: 'player.minecraft_username_removed',
    player,
    previousPlayer
  });

  res.json({ ok: true, player, previousPlayer });
}));

app.post('/api/minecraft/xuid-discovery', requireApiToken, asyncRoute(async (req, res) => {
  const minecraftUsername = requireString(req.body?.minecraftUsername, 'minecraftUsername');
  const xuid = requireString(req.body?.xuid, 'xuid');
  const serverKey = req.body?.serverKey ? String(req.body.serverKey).trim() : null;
  const result = await database.saveDiscoveredXuid({
    minecraftUsername,
    xuid,
    serverKey,
    actorId: serverKey
  });

  io.to('admin').emit('minecraft:xuidDiscovered', {
    ...result,
    minecraftUsername,
    xuid,
    serverKey
  });

  res.status(result.status === 'conflict' ? 409 : result.status === 'not_found' ? 404 : 200).json(result);
}));

app.get('/api/service-agents', requireApiToken, asyncRoute(async (req, res) => {
  const agents = await database.listServiceAgents();
  res.json({ ok: true, agents });
}));

registerConfigurationRoutes({ app, store: configurationStore, requireApiToken, asyncRoute, requestDiscordAdminCheck });

app.get('/api/discord/users/:discordUserId/admin', requireApiToken, asyncRoute(async (req, res) => {
  const discordUserId = requireString(req.params.discordUserId, 'discordUserId');
  const result = await requestDiscordAdminCheck(discordUserId);
  if (!result.allowed) Log.warn('Discord Auth', `Admin check denied userId=${discordUserId} reason=${result.reason || 'unknown'}`);
  res.json({
    ok: true,
    discordUserId,
    allowed: Boolean(result.allowed),
    reason: result.reason || null
  });
}));

app.get('/api/admin/backend/status', requireApiToken, asyncRoute(async (req, res) => {
  const databaseHealth = await database.healthCheck();
  const agents = await database.listServiceAgents();
  res.json({
    ok: true,
    service: 'pilotmc-backend',
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: databaseHealth.database,
    checkedAt: databaseHealth.now,
    minecraftServers: agents.filter((agent) => agent.enabled && agent.serverKey).length
  });
}));

app.get('/api/admin/discord/status', requireApiToken, asyncRoute(async (req, res) => {
  const result = await requestDiscordEvent('discord:getStatus', {});
  res.json({ ok: true, status: result.status });
}));

app.get('/api/admin/minecraft', requireApiToken, asyncRoute(async (req, res) => {
  const agents = await database.listServiceAgents();
  const servers = [];

  for (const agent of agents.filter((entry) => entry.enabled && entry.serverKey)) {
    let status = null;
    let available = true;
    let error = null;

    try {
      const fetched = await fetchAgent(agent.serverKey, '/api/status', { method: 'GET' });
      status = fetched.response || null;
    } catch (err) {
      available = false;
      error = err.message;
      status = latestServerStatus.get(agent.serverKey) || null;
    }

    const playerList = latestMinecraftPlayerLists.get(agent.serverKey) || latestServerPlayers.get(agent.serverKey) || null;
    const players = Array.isArray(playerList?.players) ? playerList.players : [];

    servers.push({
      serverKey: agent.serverKey,
      displayName: agent.displayName || agent.serviceName || agent.serverKey,
      serviceName: agent.serviceName,
      available,
      error,
      status,
      cachedStatus: latestServerStatus.get(agent.serverKey) || null,
      playerCount: players.length,
      playersReceivedAt: playerList?.receivedAt || null
    });
  }

  res.json({ ok: true, servers });
}));

app.get('/api/admin/minecraft/:serverKey', requireApiToken, asyncRoute(async (req, res) => {
  const serverKey = requireString(req.params.serverKey, 'serverKey');
  const agent = await database.getServiceAgentByServerKey(serverKey);
  if (!agent) return res.status(404).json({ ok: false, error: 'Minecraft server not found' });

  let status = null;
  let available = true;
  let error = null;

  try {
    const fetched = await fetchAgent(serverKey, '/api/status', { method: 'GET' });
    status = fetched.response || null;
  } catch (err) {
    available = false;
    error = err.message;
    status = latestServerStatus.get(serverKey) || null;
  }

  const playerList = latestMinecraftPlayerLists.get(serverKey) || latestServerPlayers.get(serverKey) || null;
  const players = Array.isArray(playerList?.players) ? playerList.players : [];

  res.json({
    ok: true,
    server: {
      serverKey,
      displayName: agent.displayName || agent.serviceName || serverKey,
      serviceName: agent.serviceName,
      available,
      error,
      status,
      cachedStatus: latestServerStatus.get(serverKey) || null,
      players,
      playersReceivedAt: playerList?.receivedAt || null
    }
  });
}));

app.get('/api/admin/users', requireApiToken, asyncRoute(async (req, res) => {
  const users = await database.listPlayers();
  const metadata = await requestDiscordEvent('discord:getAdminMetadata', {
    discordUserIds: users.map((user) => user.discordUserId).filter(Boolean)
  }).catch((err) => ({ ok: false, users: [], questions: [], error: err.message }));
  const discordUsers = new Map((metadata.users || []).map((user) => [user.discordUserId, user]));
  res.json({
    ok: true,
    users: users.map((user) => ({ ...user, discord: discordUsers.get(user.discordUserId) || null })),
    questions: metadata.questions || [],
    metadataError: metadata.ok === false ? metadata.error : null
  });
}));

app.get('/api/debug/socket-relay', requireApiToken, (req, res) => {
  const sockets = Array.from(io.sockets.sockets.values()).map((socket) => ({
    id: socket.id,
    role: socket.data.role || null,
    serverKey: socket.data.serverKey || null,
    rooms: Array.from(socket.rooms).filter((room) => room !== socket.id)
  }));

  res.json({
    ok: true,
    connectedSockets: sockets,
    recentEvents: socketRelayEvents.slice().reverse()
  });
});

app.get('/api/debug/runtime', requireApiToken, (req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    cwd: process.cwd(),
    file: __filename,
    buildMarker: BUILD_MARKER,
    minecraftEventHandlerMarker: MINECRAFT_EVENT_HANDLER_MARKER,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    sockets: Array.from(io.sockets.sockets.values()).map((socket) => ({
      id: socket.id,
      role: socket.data.role || null,
      serverKey: socket.data.serverKey || null,
      rooms: Array.from(socket.rooms).filter((room) => room !== socket.id)
    }))
  });
});

app.get('/api/servers/:serverKey/status', requireApiToken, asyncRoute(async (req, res) => {
  const { agent, response } = await fetchAgent(req.params.serverKey, '/api/status', {
    method: 'GET'
  });
  res.json({ ok: true, agent, status: response });
}));

app.post('/api/servers/:serverKey/commands', requireApiToken, asyncRoute(async (req, res) => {
  const action = requireString(req.body?.action, 'action');
  const command = req.body?.command;
  const actor = getActor(req);
  const agentPath = SERVER_ACTIONS.has(action) ? '/api/server-action' : '/api/server-command';

  const { agent, response } = await fetchAgent(req.params.serverKey, agentPath, {
    method: 'POST',
    body: JSON.stringify({ ...req.body, action, command })
  });

  await database.createAuditEvent({
    ...actor,
    eventType: 'server.command_sent',
    targetType: 'server',
    targetId: req.params.serverKey,
    details: action === 'inventory:get'
      ? { action, agent: agent.serviceName, liveInventoryRead: true, responseStored: false }
      : { action, command, agent: agent.serviceName, response }
  });

  res.json({ ok: true, agent, result: response });
}));

app.post('/api/servers/:serverKey/allowlist', requireApiToken, asyncRoute(async (req, res) => {
  const actor = getActor(req);
  const player = req.body?.playerId
    ? await database.getPlayerById(req.body.playerId)
    : await database.getPlayerByDiscordUserId(requireString(req.body?.discordUserId, 'discordUserId'));

  if (!player) return res.status(404).json({ ok: false, error: 'Player not found' });

  const payload = {
    playerId: player.id,
    username: player.minecraftUsername,
    xuid: player.xuid,
    permitted: req.body?.permitted !== false,
    ignoresPlayerLimit: Boolean(req.body?.ignoresPlayerLimit)
  };

  const { agent, response } = await fetchAgent(req.params.serverKey, '/api/allowlist', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  await database.createAuditEvent({
    ...actor,
    eventType: 'server.allowlist_upsert_requested',
    targetType: 'server',
    targetId: req.params.serverKey,
    details: { player, payload, agent: agent.serviceName, response }
  });

  res.json({ ok: true, player, agent, result: response });
}));

app.delete('/api/servers/:serverKey/allowlist/:playerId', requireApiToken, asyncRoute(async (req, res) => {
  const actor = getActor(req);
  const player = await database.getPlayerById(req.params.playerId);
  if (!player) return res.status(404).json({ ok: false, error: 'Player not found' });

  const { agent, response } = await fetchAgent(
    req.params.serverKey,
    `/api/allowlist/${encodeURIComponent(player.id)}`,
    { method: 'DELETE' }
  );

  await database.createAuditEvent({
    ...actor,
    eventType: 'server.allowlist_remove_requested',
    targetType: 'server',
    targetId: req.params.serverKey,
    details: { player, agent: agent.serviceName, response }
  });

  res.json({ ok: true, player, agent, result: response });
}));

io.on('connection', (socket) => {
  const role = socket.handshake.auth?.role || socket.handshake.query?.role;
  const serverKey = socket.handshake.auth?.serverKey || socket.handshake.query?.serverKey;

  socket.data.role = role || null;
  socket.data.serverKey = serverKey || null;

  if (role === 'admin') socket.join('admin');
  if (role === 'discord') socket.join('discord');
  if (role === 'minecraft-agent') socket.join('minecraft-agents');
  if (serverKey) socket.join(`server:${serverKey}`);

  rememberSocketRelayEvent('socket:connected', { role, serverKey, socketId: socket.id });
  Log.info('Socket', `Connected role=${role || 'unknown'} serverKey=${serverKey || 'none'} id=${socket.id}`);

  socket.on('disconnect', (reason) => {
    rememberSocketRelayEvent('socket:disconnected', { role, serverKey, socketId: socket.id, event: reason });
    Log.info('Socket', `Disconnected role=${role || 'unknown'} serverKey=${serverKey || 'none'} id=${socket.id} reason=${reason}`);
  });

  socket.on('server:heartbeat', (payload) => {
    io.to('admin').emit('server:heartbeat', payload);
    if (payload?.serverKey) io.to(`server:${payload.serverKey}`).emit('server:heartbeat', payload);
  });

  socket.on('server:status', (payload) => {
    rememberServerStatus(payload);
    Log.info('Server Status', `${payload?.serverKey || serverKey || 'unknown'} state=${payload?.state || 'unknown'} message=${payload?.message || ''}`);
    io.to('admin').emit('server:status', payload);
    if (payload?.serverKey) io.to(`server:${payload.serverKey}`).emit('server:status', payload);
  });

  socket.on('server:players', (payload) => {
    rememberServerPlayers(payload);
    io.to('admin').emit('server:players', payload);
    if (payload?.serverKey) io.to(`server:${payload.serverKey}`).emit('server:players', payload);
  });

  socket.on('server:log', (payload) => {
    rememberSocketRelayEvent('server:log', { ...payload, role, socketId: socket.id, event: payload?.level });
    const level = ['debug', 'error', 'info', 'warn'].includes(payload?.level) ? payload.level : 'info';
    const message = String(payload?.message || '').trim();
    const noisyInfo = level === 'info' && (
      /^Automatic backup started \(/.test(message)
      || /^Sent command: save (hold|query|resume)$/.test(message)
      || message === 'Saving...'
      || /^Data saved\. Files are now ready to be copied\.$/.test(message)
      || /^Bedrock level\/.+?:\d+(?:, Bedrock level\/.+?:\d+)+$/.test(message)
      || /^World backup created at /.test(message)
    );
    if (!noisyInfo) Log[level]('Server Log', `${payload?.serverKey || serverKey || 'unknown'} ${message}`);
    io.to('admin').emit('server:log', payload);
    io.to('discord').emit('server:log', payload);
    if (payload?.serverKey) io.to(`server:${payload.serverKey}`).emit('server:log', payload);
  });

  socket.on('server:backup', (payload) => {
    rememberSocketRelayEvent('server:backup', { ...payload, role, socketId: socket.id });
    Log.info('Server Backup', `${payload?.serverKey || serverKey || 'unknown'} ${payload?.message || payload?.status || 'backup event'}`);
    io.to('admin').emit('server:backup', payload);
    io.to('discord').emit('server:backup', payload);
    if (payload?.serverKey) io.to(`server:${payload.serverKey}`).emit('server:backup', payload);
  });

  socket.on('minecraft:playerJoined', (payload) => {
    io.to('admin').emit('minecraft:playerJoined', payload);
    io.to('discord').emit('minecraft:playerJoined', payload);
  });

  socket.on('minecraft:playerLeft', (payload) => {
    io.to('admin').emit('minecraft:playerLeft', payload);
    io.to('discord').emit('minecraft:playerLeft', payload);
  });

  socket.on('minecraft:event', (payload) => {
    const isPlayerList = payload?.event === 'playerList';
    if (isPlayerList) rememberMinecraftPlayerList(payload);
    if (!isPlayerList) {
      rememberSocketRelayEvent('minecraft:event', { ...payload, role, socketId: socket.id });
      io.to('discord').timeout(5000).emit('minecraft:event', payload, (err, responses = []) => {
        if (err) {
          Log.warn(
            'Socket Relay',
            `minecraft:event ${payload?.event || 'unknown'} from ${payload?.serverKey || serverKey || 'unknown'} was not acknowledged by all Discord socket(s): ${err.message}`
          );
          return;
        }

      });
      Log.info(
        'Minecraft Event',
        `${MINECRAFT_EVENT_HANDLER_MARKER} ${payload?.serverKey || serverKey || 'unknown'} event=${payload?.event || 'unknown'}`,
        payload?.content || {}
      );
    }
    try {
      io.to('admin').emit('minecraft:event', payload);
      if (payload?.serverKey) io.to(`server:${payload.serverKey}`).emit('minecraft:event', payload);
    } catch (err) {
      Log.warn('Socket Relay', `Failed to relay minecraft:event to admin/server rooms: ${err.message}`);
    }
  });
});

app.use((err, req, res, next) => {
  Log.error('HTTP', 'Request failed:', err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    ok: false,
    error: err.message || 'Internal server error',
    agentResponse: err.agentResponse,
    validationErrors: err.validationErrors
  });
});

async function start() {
  await database.validateSchema();
  await configurationStore.initialize(readSeed);
  const snapshot = await configurationStore.read();
  AGENT_TIMEOUT_MS = snapshot.config.backend.agentTimeoutMs;
  DISCORD_AUTH_TIMEOUT_MS = snapshot.config.backend.discordAuthTimeoutMs;
  await configurationStore.report('backend', snapshot.revision, snapshot.revision);
  setInterval(async () => {
    try { const latest = await configurationStore.read(); await configurationStore.report('backend', snapshot.revision, latest.revision); }
    catch (err) { Log.warn('Configuration', `Status report failed: ${err.message}`); }
  }, 30000).unref();
  server.listen(PORT, () => {
    Log.info('Backend', `pilotmc-backend listening on :${PORT}`);
    Log.info('Backend', `Build marker ${BUILD_MARKER}`);
    Log.info('Backend', `Loaded from ${__filename}`);
  });
}

async function shutdown(signal) {
  Log.info('Backend', `${signal} received, shutting down...`);
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  Log.error('Backend', 'Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  Log.error('Backend', 'Unhandled rejection:', reason);
});

start().catch((err) => {
  Log.error('Backend', 'Failed to start:', err);
  process.exit(1);
});
