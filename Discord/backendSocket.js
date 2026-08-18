const Log = require('./log');
const minecraftBridge = require('./minecraftBridge');
const botConfig = require('./config');

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
const BACKEND_API_TOKEN = process.env.BACKEND_API_TOKEN || '';
const ADMIN_ROLE_ID = botConfig?.roles?.admin;
const STARTED_AT = new Date();

function loadSocketClient() {
  try {
    return require('socket.io-client').io;
  } catch (err) {
    Log.warn('Backend Socket', 'socket.io-client is not installed. Backend socket bridge is disabled.');
    return null;
  }
}

function registerSocketHandler(socket, eventName, handler, errorMessage) {
  socket.on(eventName, async (payload, respond) => {
    try {
      await handler(payload);
      if (typeof respond === 'function') {
        respond({ ok: true });
      }
    } catch (err) {
      Log.error('Backend Socket', errorMessage, err.message);
      if (typeof respond === 'function') {
        respond({ ok: false, error: err.message });
      }
    }
  });
}

async function dispatchModuleHandler(modules, handlerName, client, payload) {
  for (const mod of modules) {
    const handler = mod.handlers?.[handlerName];
    if (typeof handler !== 'function') continue;
    await handler(client, payload);
  }
}

async function getGuild(client) {
  if (process.env.DISCORD_GUILD_ID) {
    return client.guilds.cache.get(process.env.DISCORD_GUILD_ID)
      || client.guilds.fetch(process.env.DISCORD_GUILD_ID).catch(() => null);
  }

  if (client.guilds.cache.size === 1) return client.guilds.cache.first();
  return null;
}

function getCachedGuild(client) {
  if (process.env.DISCORD_GUILD_ID) {
    return client.guilds.cache.get(process.env.DISCORD_GUILD_ID) || null;
  }

  if (client.guilds.cache.size === 1) return client.guilds.cache.first();
  return null;
}

async function checkAdminRole(client, payload) {
  const discordUserId = typeof payload?.discordUserId === 'string' ? payload.discordUserId.trim() : '';
  if (!discordUserId) {
    return { ok: false, allowed: false, statusCode: 400, error: 'discordUserId is required.' };
  }
  if (!ADMIN_ROLE_ID) {
    return { ok: false, allowed: false, statusCode: 500, error: 'Admin role is not configured.' };
  }

  const guild = await getGuild(client);
  if (!guild) {
    return { ok: false, allowed: false, statusCode: 503, error: 'Discord guild is unavailable.' };
  }

  const member = guild.members.cache.get(discordUserId)
    || await guild.members.fetch(discordUserId).catch(() => null);
  const allowed = Boolean(member?.roles?.cache?.has(ADMIN_ROLE_ID));
  return {
    ok: true,
    allowed,
    discordUserId,
    guildId: guild.id,
    roleId: ADMIN_ROLE_ID,
    reason: allowed ? 'admin_role' : 'missing_admin_role'
  };
}

function getDiscordStatus(client, commands) {
  const guilds = Array.from(client.guilds.cache.values());
  return {
    online: Boolean(client.isReady()),
    username: client.user?.tag || null,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.floor((client.uptime || 0) / 1000),
    guilds: guilds.map((guild) => ({
      id: guild.id,
      name: guild.name,
      cachedMembers: guild.members.cache.size
    })),
    commands: Array.isArray(commands) ? commands : [],
    config: {
      minecraftServers: Array.isArray(botConfig.minecraftServers)
        ? botConfig.minecraftServers.map((server) => ({
          key: server.key,
          name: server.name,
          chatEnabled: Boolean(server.chat?.enabled),
          autoAllowlistOnSetMinecraftUsername: Boolean(server.autoAllowlistOnSetMinecraftUsername)
        }))
        : [],
      channels: Object.keys(botConfig.channels || {}),
      roles: Object.keys(botConfig.roles || {})
    }
  };
}

async function getAdminMetadata(client, payload = {}) {
  const guild = await getGuild(client);
  if (!guild) {
    return { ok: false, statusCode: 503, error: 'Discord guild is unavailable.' };
  }

  const discordUserIds = Array.isArray(payload.discordUserIds)
    ? [...new Set(payload.discordUserIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  const users = [];
  for (const discordUserId of discordUserIds) {
    const member = guild.members.cache.get(discordUserId)
      || await guild.members.fetch(discordUserId).catch(() => null);
    users.push({
      discordUserId,
      username: member?.user?.username || null,
      globalName: member?.user?.globalName || null,
      displayName: member?.displayName || member?.user?.globalName || member?.user?.username || null
    });
  }

  const questions = Array.isArray(botConfig.questions)
    ? botConfig.questions
      .filter((question) => question?.id && (question.prompt || question.label))
      .map((question) => ({
        id: String(question.id),
        label: String(question.label || question.prompt),
        prompt: String(question.prompt || question.label)
      }))
    : [];
  return { ok: true, users, questions };
}

function registerBackendSocketBridge(client, options = {}) {
  const io = loadSocketClient();
  if (!io) return;
  const modules = Array.isArray(options.modules) ? options.modules : [];
  const commands = options.commands ? Array.from(options.commands.keys()) : [];

  Log.info('Backend Socket', `Starting Discord Backend Socket.IO bridge to ${BACKEND_URL}.`);

  const socket = io(BACKEND_URL, {
    auth: { role: 'discord', token: BACKEND_API_TOKEN },
    reconnection: true
  });

  socket.on('connect', () => {
    Log.info('Backend Socket', 'Discord bot connected to Backend Socket.IO.');
  });

  socket.on('connect_error', (err) => {
    Log.warn('Backend Socket', `Unable to connect to Backend Socket.IO: ${err.message}`);
  });

  socket.on('disconnect', (reason) => {
    Log.warn('Backend Socket', `Disconnected from Backend Socket.IO: ${reason}`);
  });

  socket.on('discord:checkAdmin', async (payload, respond) => {
    try {
      const result = await checkAdminRole(client, payload);
      if (typeof respond === 'function') respond(result);
    } catch (err) {
      Log.error('Backend Socket', 'Failed to check admin role:', err);
      if (typeof respond === 'function') {
        respond({ ok: false, allowed: false, statusCode: 500, error: err.message });
      }
    }
  });

  socket.on('discord:getStatus', (payload, respond) => {
    try {
      if (typeof respond === 'function') {
        respond({ ok: true, status: getDiscordStatus(client, commands) });
      }
    } catch (err) {
      Log.error('Backend Socket', 'Failed to get Discord status:', err);
      if (typeof respond === 'function') {
        respond({ ok: false, statusCode: 500, error: err.message });
      }
    }
  });

  socket.on('discord:getAdminMetadata', async (payload, respond) => {
    try {
      const result = await getAdminMetadata(client, payload);
      if (typeof respond === 'function') respond(result);
    } catch (err) {
      Log.error('Backend Socket', 'Failed to load admin Discord metadata:', err);
      if (typeof respond === 'function') {
        respond({ ok: false, statusCode: 500, error: err.message });
      }
    }
  });

  registerSocketHandler(
    socket,
    'minecraft:event',
    async (payload) => {
      await minecraftBridge.handleMinecraftEvent(client, payload);
      await dispatchModuleHandler(modules, 'minecraft:event', client, payload);
    },
    'Failed to handle Minecraft event:'
  );
  registerSocketHandler(
    socket,
    'server:log',
    (payload) => minecraftBridge.handleServerLog(client, payload),
    'Failed to handle server log:'
  );
  registerSocketHandler(
    socket,
    'server:backup',
    (payload) => minecraftBridge.handleServerBackup(client, payload),
    'Failed to handle server backup:'
  );
  registerSocketHandler(
    socket,
    'server:status',
    (payload) => minecraftBridge.handleServerStatus(client, payload),
    'Failed to handle server status:'
  );

  minecraftBridge.registerDiscordToMinecraftRelay(client);
}

module.exports = {
  registerBackendSocketBridge
};
