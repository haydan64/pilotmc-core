const { EmbedBuilder } = require('discord.js');
const backend = require('./backendClient');
const { getMinecraftServer, listMinecraftServers } = require('./minecraftServers');
const Log = require('./log');
const botConfig = require('./config');

const CHAT_WEBHOOK_NAME = botConfig?.webhooks?.minecraftChatName;
const MEMBER_ROLE_ID = botConfig?.roles?.member;
const channelWebhookCache = new Map();

function getChatConfig(serverKey) {
  const server = getMinecraftServer(serverKey);
  if (!server?.chat?.enabled || !server.chat.channelId) return null;
  return {
    server,
    channelId: server.chat.channelId
  };
}

function getBdsLogChannelId() {
  return process.env.DISCORD_BDS_LOG_CHANNEL_ID || botConfig?.channels?.bdsLog || botConfig?.channels?.discordLog || null;
}

function getDeveloperRoleId() {
  return botConfig?.roles?.developer || null;
}

async function fetchChannel(client, channelId) {
  const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) return null;
  return channel;
}

async function getChatWebhook(channel) {
  if (!CHAT_WEBHOOK_NAME) {
    Log.warn('Minecraft Bridge', 'botConfig.webhooks.minecraftChatName is not configured.');
    return null;
  }

  if (channelWebhookCache.has(channel.id)) return channelWebhookCache.get(channel.id);

  const existing = await channel.fetchWebhooks().catch((err) => {
    Log.warn('Minecraft Bridge', `Unable to fetch webhooks for channel ${channel.id}: ${err.message}`);
    return null;
  });

  const webhook = existing?.find((entry) => entry.name === CHAT_WEBHOOK_NAME)
    || await channel.createWebhook({ name: CHAT_WEBHOOK_NAME }).catch((err) => {
      Log.warn('Minecraft Bridge', `Unable to create chat webhook for channel ${channel.id}: ${err.message}`);
      return null;
    });

  if (webhook) channelWebhookCache.set(channel.id, webhook);
  return webhook;
}

function sanitizeTellrawText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .trim();
}

function buildTellrawMessage(name, message) {
  return `tellraw @a {"rawtext":[{"text":"\\u00a79<${sanitizeTellrawText(name)}>\\u00a7r ${sanitizeTellrawText(message)}"}]}`;
}

function quoteBedrockName(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function getCachedGuild(client) {
  if (process.env.DISCORD_GUILD_ID) return client.guilds.cache.get(process.env.DISCORD_GUILD_ID) || null;
  if (client.guilds.cache.size === 1) return client.guilds.cache.first();
  return null;
}

async function getGuild(client) {
  if (process.env.DISCORD_GUILD_ID) {
    return client.guilds.cache.get(process.env.DISCORD_GUILD_ID)
      || client.guilds.fetch(process.env.DISCORD_GUILD_ID).catch(() => null);
  }

  if (client.guilds.cache.size === 1) return client.guilds.cache.first();
  return null;
}

async function checkMemberMembership(client, discordUserId) {
  if (!discordUserId) return { ok: false, allowed: false, reason: 'missing_discord_user_id' };
  if (!MEMBER_ROLE_ID) return { ok: false, allowed: false, reason: 'member_role_not_configured' };

  const guild = getCachedGuild(client) || await getGuild(client);
  if (!guild) return { ok: false, allowed: false, reason: 'guild_unavailable' };

  const cachedMember = guild.members.cache.get(discordUserId) || null;
  const member = cachedMember || await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) return { ok: true, allowed: false, reason: 'not_in_discord' };

  return {
    ok: true,
    allowed: Boolean(member.roles?.cache?.has(MEMBER_ROLE_ID)),
    reason: member.roles?.cache?.has(MEMBER_ROLE_ID)
      ? cachedMember ? 'member_role_cached' : 'member_role_fetched'
      : 'missing_member_role'
  };
}

async function rejectMinecraftJoin(client, payload, username, reason, player = null) {
  const serverKey = payload.serverKey;
  const message = reason === 'not_linked'
    ? 'Please link your Discord account before joining.'
    : 'Please rejoin Discord and make sure you have the configured member role.';

  await backend.sendServerCommand(
    serverKey,
    {
      action: 'command',
      command: `kick ${quoteBedrockName(username)} ${message}`
    },
    player?.discordUserId || null
  ).catch((err) => {
    Log.warn('Minecraft Bridge', `Failed to kick ${username} from ${serverKey}: ${err.message}`);
  });

  if (player?.id) {
    await backend.removePlayerFromServerAllowlist(serverKey, player.id, player.discordUserId).catch((err) => {
      Log.warn('Minecraft Bridge', `Failed to remove allowlist for ${username} on ${serverKey}: ${err.message}`);
    });
  } else {
    await backend.sendServerCommand(
      serverKey,
      {
        action: 'command',
        command: `allowlist remove ${quoteBedrockName(username)}`
      },
      null
    ).catch((err) => {
      Log.warn('Minecraft Bridge', `Failed to remove raw allowlist entry for ${username} on ${serverKey}: ${err.message}`);
    });
  }

  const channelId = getBdsLogChannelId();
  const channel = channelId ? await fetchChannel(client, channelId) : null;
  if (channel) {
    await channel.send(`Join rejected: **${getServerDisplayName(serverKey)}** - **${username}** (${reason}).`);
  }
}

async function verifyMinecraftJoin(client, payload = {}) {
  if (payload.event !== 'playerJoin') return { allowed: true };
  const username = payload.content?.username;
  if (!username) return { allowed: true };

  let player = null;
  try {
    const result = await backend.getPlayerByMinecraftUsername(username);
    player = result?.player || null;
  } catch (err) {
    if (err.statusCode === 404) {
      await rejectMinecraftJoin(client, payload, username, 'not_linked');
      return { allowed: false, reason: 'not_linked' };
    }
    Log.warn('Minecraft Bridge', `Unable to verify linked Discord account for ${username}: ${err.message}`);
    return { allowed: true, reason: 'verification_unavailable' };
  }

  if (!player?.discordUserId) {
    await rejectMinecraftJoin(client, payload, username, 'not_linked', player);
    return { allowed: false, reason: 'not_linked' };
  }

  const membership = await checkMemberMembership(client, player.discordUserId);
  if (!membership.allowed) {
    await rejectMinecraftJoin(client, payload, username, membership.reason || 'missing_member_role', player);
    return { allowed: false, reason: membership.reason || 'missing_member_role' };
  }

  return { allowed: true, reason: membership.reason };
}

async function resolveDiscordAuthorMinecraftName(message) {
  const fallbackName = message.member?.displayName || message.author.globalName || message.author.username;
  try {
    const result = await backend.getPlayerByDiscordUserId(message.author.id);
    return result?.player?.minecraftUsername || fallbackName;
  } catch (err) {
    if (err.statusCode !== 404) {
      Log.warn('Minecraft Bridge', `Unable to resolve Minecraft username for ${message.author.id}: ${err.message}`);
    }
    return fallbackName;
  }
}

function decamelize(str) {
  return String(str || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

function formatDeathMessage(content = {}) {
  const name = content.entityName || content.entityType || content.entity || 'An entity';
  let killer = content.damagingEntityName || content.damagingEntityType || content.damagingEntity;
  if (killer?.includes(':')) killer = decamelize(killer.split(':')[1]);
  const cause = content.cause ? decamelize(content.cause) : null;
  const action = cause === 'entityattack' ? 'was slain' : cause === 'projectile' ? 'was shot' : 'was killed';
  if (killer && cause) return `**${name}** ${action} by ${killer} using ${cause}.`;
  if (killer) return `**${name}** ${action} by ${killer}.`;
  if (cause) return `**${name}** ${action} by ${cause}.`;
  return `**${name}** ${action}.`;
}

async function resolveMinecraftDisplay(client, minecraftName) {
  if (!minecraftName) return { displayName: 'Unknown', avatarUrl: null };

  try {
    const result = await backend.getPlayerByMinecraftUsername(minecraftName);
    const discordUserId = result?.player?.discordUserId;
    if (!discordUserId) return { displayName: minecraftName, avatarUrl: null };

    const user = await client.users.fetch(discordUserId).catch(() => null);
    if (!user) return { displayName: minecraftName, avatarUrl: null };

    return {
      displayName: user.globalName || user.username || minecraftName,
      avatarUrl: user.displayAvatarURL?.({ size: 256 }) || null
    };
  } catch {
    return { displayName: minecraftName, avatarUrl: null };
  }
}

async function handleMinecraftEvent(client, payload = {}) {
  if (payload.event === 'playerList') return;

  Log.info('Minecraft Bridge', `Received Minecraft event ${payload.event || 'unknown'} from ${payload.serverKey || 'unknown server'}.`);
  const joinVerification = await verifyMinecraftJoin(client, payload);
  if (!joinVerification.allowed) {
    Log.warn('Minecraft Bridge', `Rejected Minecraft join for ${payload.content?.username || 'unknown'} on ${payload.serverKey || 'unknown'}: ${joinVerification.reason}`);
    return;
  }
  if (payload.event === 'playerJoin') {
    Log.info(
      'Minecraft Bridge',
      `Verified Minecraft join for ${payload.content?.username || 'unknown'} on ${payload.serverKey || 'unknown'}: ${joinVerification.reason || 'ok'}.`
    );
  }

  const chatConfig = getChatConfig(payload.serverKey);
  if (!chatConfig) {
    Log.info('Minecraft Bridge', `No enabled chat channel configured for ${payload.serverKey || 'unknown server'}.`);
    return;
  }

  const channel = await fetchChannel(client, chatConfig.channelId);
  if (!channel) {
    Log.warn('Minecraft Bridge', `Configured chat channel ${chatConfig.channelId} was not found.`);
    return;
  }

  const content = payload.content || {};

  if (payload.event === 'chatSent' && content.sender) {
    const { displayName, avatarUrl } = await resolveMinecraftDisplay(client, content.sender);
    const message = String(content.message || '').trim();
    if (!message) return;
    const webhook = await getChatWebhook(channel);
    if (!webhook) return;
    await webhook.send({
      username: displayName,
      avatarURL: avatarUrl || undefined,
      content: message,
      allowedMentions: { parse: [] }
    });
    Log.info('Minecraft Bridge', `Relayed Minecraft chat from ${content.sender} to Discord channel ${chatConfig.channelId}.`);
    return;
  }

  if (payload.event === 'playerJoin' && content.username) {
    const { displayName, avatarUrl } = await resolveMinecraftDisplay(client, content.username);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: displayName, iconURL: avatarUrl || undefined })
          .setDescription(`**${displayName}** joined the game.`)
          .setColor(0x57f287)
          .setTimestamp()
      ],
      allowedMentions: { parse: [] }
    });
    Log.info('Minecraft Bridge', `Relayed Minecraft join for ${content.username} to Discord channel ${chatConfig.channelId}.`);
    return;
  }

  if (payload.event === 'playerLeave' && content.username) {
    const { displayName, avatarUrl } = await resolveMinecraftDisplay(client, content.username);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: displayName, iconURL: avatarUrl || undefined })
          .setDescription(`**${displayName}** left the game.`)
          .setColor(0xfee75c)
          .setTimestamp()
      ],
      allowedMentions: { parse: [] }
    });
    Log.info('Minecraft Bridge', `Relayed Minecraft leave for ${content.username} to Discord channel ${chatConfig.channelId}.`);
    return;
  }

  if (payload.event === 'entityDied' && content.entityType === 'minecraft:player') {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(formatDeathMessage(content))
          .setColor(0xed4245)
          .setTimestamp()
      ],
      allowedMentions: { parse: [] }
    });
    Log.info('Minecraft Bridge', `Relayed Minecraft death event to Discord channel ${chatConfig.channelId}.`);
  }
}

function getServerDisplayName(serverKey) {
  return getMinecraftServer(serverKey)?.name || serverKey || 'Unknown server';
}

function truncateDiscordMessage(value, maxLength = 1600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 15)} [truncated]`;
}

async function handleServerLog(client, payload = {}) {
  const message = truncateDiscordMessage(payload.message || '');
  if (!/^automatic backup failed:|^backup failed:/i.test(message)) return;

  const channelId = getBdsLogChannelId();
  if (!channelId) return;

  const channel = await fetchChannel(client, channelId);
  if (!channel) {
    Log.warn('Minecraft Bridge', `Configured BDS log channel ${channelId} was not found.`);
    return;
  }

  await channel.send(`Backup failed: **${getServerDisplayName(payload.serverKey)}** - ${message}`);
}

async function handleServerBackup(client, payload = {}) {
  const channelId = getBdsLogChannelId();
  if (!channelId) return;

  const channel = await fetchChannel(client, channelId);
  if (!channel) {
    Log.warn('Minecraft Bridge', `Configured BDS log channel ${channelId} was not found.`);
    return;
  }

  const message = truncateDiscordMessage(payload.message || 'Backup completed.');
  await channel.send(`Backup complete: **${getServerDisplayName(payload.serverKey)}** - ${message}`);
}

async function handleServerStatus(client, payload = {}) {
  const state = String(payload.state || '').toLowerCase();
  const messageText = String(payload.message || '').toLowerCase();
  const crashed = state === 'crashed' || state === 'error' || messageText.includes('crash');
  if (!crashed) return;

  const channelId = getBdsLogChannelId();
  if (!channelId) return;

  const channel = await fetchChannel(client, channelId);
  if (!channel) {
    Log.warn('Minecraft Bridge', `Configured BDS log channel ${channelId} was not found.`);
    return;
  }

  const developerRoleId = getDeveloperRoleId();
  const serverName = getServerDisplayName(payload.serverKey);
  const message = truncateDiscordMessage(payload.message || state || '[server status]');
  const mention = developerRoleId ? `<@&${developerRoleId}> ` : '';
  await channel.send({
    content: `${mention}**${serverName} crashed or entered an error state.** ${message}`,
    allowedMentions: { roles: developerRoleId ? [developerRoleId] : [] }
  });
}

function registerDiscordToMinecraftRelay(client) {
  client.on('messageCreate', async (message) => {
    if (message.author?.bot || message.webhookId) return;

    const server = listMinecraftServers().find(
      (entry) => entry?.chat?.enabled && entry.chat.channelId === message.channelId
    );
    if (!server) return;

    const contentParts = [];
    if (message.content) contentParts.push(message.content.trim());
    if (message.attachments?.size) {
      contentParts.push([...message.attachments.values()].map((attachment) => attachment.url).join(' '));
    }

    const content = contentParts.join(' ').trim();
    if (!content) return;

    try {
      const minecraftName = await resolveDiscordAuthorMinecraftName(message);
      await backend.sendServerCommand(
        server.key,
        {
          action: 'command',
          command: buildTellrawMessage(minecraftName, content)
        },
        message.author.id
      );
    } catch (err) {
      Log.warn('Minecraft Bridge', `Failed to relay Discord message to ${server.key}: ${err.message}`);
    }
  });
}

module.exports = {
  handleMinecraftEvent,
  handleServerBackup,
  handleServerLog,
  handleServerStatus,
  registerDiscordToMinecraftRelay
};
