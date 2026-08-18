const path = require('path');
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const { loadCommands } = require('./loadCommands');
const { loadModules } = require('./moduleLoader');
const { safeReply, isRecoverableInteractionError } = require('./commands/interactionResponses');
const backend = require('./backendClient');
const { registerBackendSocketBridge } = require('./backendSocket');
const { getAutoAllowlistServers, listMinecraftServers } = require('./minecraftServers');
const Log = require('./log');
const botConfig = require('./config');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const DISCORD_LOG_CHANNEL = botConfig?.channels?.discordLog;
const JOIN_LEAVE_CHANNEL = botConfig?.channels?.joinLeave;
const GUEST_ROLE_ID = botConfig?.roles?.guest;
const ROLE_IDS = {
  DEVELOPER: botConfig?.roles?.developer,
  ADMIN: botConfig?.roles?.admin,
  STAFF: botConfig?.roles?.staff
};
const EMBED_DESCRIPTION_LIMIT = 4096;
const BUILD_MARKER = 'socket-ack-relay-2026-06-28';

function truncateText(value, maxLength) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 15))}\n[truncated]`;
}

function formatUser(user) {
  return `${user.tag || user.user?.tag || user.displayName || user.id}`;
}

function memberHasRole(member, roleId) {
  return Boolean(member?.roles?.cache?.has(roleId));
}

async function ensureRole(interaction, roleIds, message) {
  const member = interaction.member;
  const allowed = roleIds.filter(Boolean).some((id) => memberHasRole(member, id));
  if (!allowed) {
    await interaction.reply({ content: message || 'You do not have permission to use this command.', ephemeral: true });
    return false;
  }
  return true;
}

async function sendToChannel(client, channelId, payload) {
  if (!channelId) return;
  try {
    const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId));
    if (!channel || !channel.isTextBased()) return;
    await channel.send(payload);
  } catch (err) {
    Log.error('Discord Bot', `Failed to send message to channel ${channelId}:`, err.message);
  }
}

function buildAuditEmbed(title, description, color = 0x2b2d31) {
  const safeDescription = truncateText(description || '[no details captured]', EMBED_DESCRIPTION_LIMIT);
  return new EmbedBuilder().setTitle(title).setDescription(safeDescription).setColor(color).setTimestamp();
}

function formatCommandOptions(interaction) {
  const options = interaction.options?.data || [];
  if (!options.length) return 'None';

  return options.map((option) => {
    const value = option.value ?? option.user?.tag ?? option.member?.displayName ?? option.channel?.name ?? option.role?.name ?? '[complex value]';
    return `${option.name}: ${value}`;
  }).join('\n');
}

function logCommandUsage(client, interaction, status, error = null) {
  const user = interaction.user;
  const channel = interaction.channel?.name || interaction.channelId || 'Unknown channel';
  const guild = interaction.guild?.name || interaction.guildId || 'Unknown guild';
  const description = [
    `User: **${formatUser(user)}** (${user.id})`,
    `Command: **/${interaction.commandName}**`,
    `Status: **${status}**`,
    `Guild: **${guild}**`,
    `Channel: **${channel}**`,
    `Options:\n${formatCommandOptions(interaction)}`,
    error ? `Error: ${error.message}` : null
  ].filter(Boolean).join('\n');

  const embed = buildAuditEmbed('Slash Command Used', description, status === 'failed' ? 0xd9534f : 0x5b9bd5);
  sendToChannel(client, DISCORD_LOG_CHANNEL, { embeds: [embed] });
}

async function unallowlistDepartedMember(member) {
  const servers = listMinecraftServers();
  if (!servers.length) return;

  let player = null;
  try {
    const result = await backend.getPlayerByDiscordUserId(member.id);
    player = result.player;
  } catch (err) {
    const statusCode = err.statusCode || err.body?.statusCode;
    if (statusCode === 404) {
      const embed = buildAuditEmbed(
        'Minecraft Allowlist Cleanup',
        `${formatUser(member)} left Discord, but no linked Minecraft player was found.`,
        0xf0ad4e
      );
      sendToChannel(member.client, DISCORD_LOG_CHANNEL, { embeds: [embed] });
      return;
    }
    throw err;
  }

  const results = [];
  for (const server of servers) {
    try {
      await backend.removePlayerFromServerAllowlist(server.key, player.id, member.id);
      results.push(`${server.name || server.key}: removed`);
    } catch (err) {
      results.push(`${server.name || server.key}: ${err.message}`);
    }
  }

  const embed = buildAuditEmbed(
    'Minecraft Allowlist Cleanup',
    [
      `${formatUser(member)} left Discord.`,
      `Minecraft: **${player.minecraftUsername || 'Not linked'}**`,
      `Player ID: **${player.id}**`,
      `Results:\n${results.join('\n') || 'No servers configured.'}`
    ].join('\n'),
    results.some((entry) => !entry.endsWith(': removed')) ? 0xf0ad4e : 0x5cb85c
  );
  sendToChannel(member.client, DISCORD_LOG_CHANNEL, { embeds: [embed] });
}

function registerAuditHandler(client, eventName, handler) {
  client.on(eventName, async (...args) => {
    try {
      await handler(...args);
    } catch (err) {
      Log.error('Discord Bot', `Error handling Discord audit event ${eventName}:`, err);
    }
  });
}

function registerDiscordAuditHandlers(client) {
  registerAuditHandler(client, 'voiceStateUpdate', (oldState, newState) => {
    const user = formatUser(newState.member || oldState.member);
    const oldChannel = oldState.channel?.name || 'None';
    const newChannel = newState.channel?.name || 'None';

    let description;
    if (!oldState.channelId && newState.channelId) {
      description = `${user} joined voice channel **${newChannel}**.`;
    } else if (oldState.channelId && !newState.channelId) {
      description = `${user} left voice channel **${oldChannel}**.`;
    } else if (oldState.channelId !== newState.channelId) {
      description = `${user} moved from **${oldChannel}** to **${newChannel}**.`;
    }

    if (description) {
      const embed = buildAuditEmbed('Voice Channel Update', description, 0x5b9bd5);
      sendToChannel(client, DISCORD_LOG_CHANNEL, { embeds: [embed] });
    }
  });

  registerAuditHandler(client, 'messageDelete', async (message) => {
    if (message.partial) await message.fetch().catch(() => null);
    const author = message.author ? formatUser(message.author) : 'Unknown user';
    const content = message.content || '[no content captured]';
    const channelName = message.channel?.name || 'Unknown channel';
    const embed = buildAuditEmbed(
      'Message Deleted',
      `Author: **${author}**\nChannel: **${channelName}**\nContent: ${content}`,
      0xd9534f
    );
    sendToChannel(client, DISCORD_LOG_CHANNEL, { embeds: [embed] });
  });

  registerAuditHandler(client, 'messageUpdate', async (oldMessage, newMessage) => {
    if (oldMessage.partial) await oldMessage.fetch().catch(() => null);
    if (newMessage.partial) await newMessage.fetch().catch(() => null);

    const author = newMessage.author ? formatUser(newMessage.author) : 'Unknown user';
    const before = oldMessage.content || '[no content captured]';
    const after = newMessage.content || '[no content captured]';
    if (before === after) return;

    const embed = buildAuditEmbed(
      'Message Edited',
      `Author: **${author}**\nBefore: ${before}\nAfter: ${after}`,
      0xf0ad4e
    );
    sendToChannel(client, DISCORD_LOG_CHANNEL, { embeds: [embed] });
  });

  registerAuditHandler(client, 'guildMemberAdd', async (member) => {
    const embed = buildAuditEmbed('Member Joined', `${formatUser(member)} joined the server.`, 0x5cb85c);
    if (GUEST_ROLE_ID && member.guild.roles.cache.has(GUEST_ROLE_ID)) {
      await member.roles.add(GUEST_ROLE_ID).catch(() => null);
    }

    sendToChannel(member.client, DISCORD_LOG_CHANNEL, { embeds: [embed] });
    if (JOIN_LEAVE_CHANNEL) {
      const joinEmbed = new EmbedBuilder()
        .setTitle('Player Joined')
        .setDescription(`<@${member.id}> has joined the server.`)
        .setColor(0x5cb85c)
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }));

      sendToChannel(member.client, JOIN_LEAVE_CHANNEL, {
        content: `<@${member.id}>`,
        embeds: [joinEmbed],
        allowedMentions: { users: [member.id] }
      });
    }
  });

  registerAuditHandler(client, 'guildMemberRemove', async (member) => {
    const embed = buildAuditEmbed('Member Left', `${formatUser(member)} left the server.`, 0xd9534f);
    sendToChannel(member.client, DISCORD_LOG_CHANNEL, { embeds: [embed] });
    await unallowlistDepartedMember(member);

    if (JOIN_LEAVE_CHANNEL) {
      const leaveEmbed = new EmbedBuilder()
        .setTitle('Player Left')
        .setDescription(`<@${member.id}> has left the server.`)
        .setColor(0xd9534f)
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }));

      sendToChannel(member.client, JOIN_LEAVE_CHANNEL, {
        content: `<@${member.id}>`,
        embeds: [leaveEmbed],
        allowedMentions: { users: [member.id] }
      });
    }
  });
}

function buildCommandContext() {
  return {
    backend,
    getAutoAllowlistServers,
    listMinecraftServers,
    roleIds: ROLE_IDS,
    rolesConfig: botConfig?.roles || {},
    ensureRole,
    formatUser
  };
}

function registerCommandHandlers(client, commands) {
  const commandContext = buildCommandContext();

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, commandContext);
      logCommandUsage(client, interaction, 'completed');
    } catch (err) {
      Log.error('Discord Bot', `Error executing command ${interaction.commandName}:`, err);
      logCommandUsage(client, interaction, 'failed', err);
      await safeReply(interaction, { content: 'There was an error executing this command.', ephemeral: true });
    }
  });
}

async function registerModuleHooks(client, modules, context) {
  for (const mod of modules) {
    if (typeof mod.register !== 'function') continue;

    try {
      await mod.register(client, context);
      Log.info('Module Loader', `Registered module hooks for ${mod.name}.`);
    } catch (err) {
      Log.error('Module Loader', `Failed to register module hooks for ${mod.name}:`, err);
    }
  }
}

async function createDiscordBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User]
  });

  const modules = await loadModules();
  const moduleCommandPaths = modules.flatMap((mod) => mod.commandPaths || []);
  const commands = loadCommands([
    path.join(__dirname, 'commands'),
    ...moduleCommandPaths
  ]);

  client.on('clientReady', () => {
    Log.info('Discord Bot', `PilotMC Discord online as ${client.user.tag}`);
    Log.info('Discord Bot', `Build marker ${BUILD_MARKER}`);
    Log.info('Discord Bot', `Loaded modules: ${modules.map((mod) => mod.name).join(', ') || '[none]'}`);
    Log.info('Discord Bot', `Loaded commands: ${Array.from(commands.keys()).join(', ') || '[none]'}`);
  });

  registerCommandHandlers(client, commands);
  registerDiscordAuditHandlers(client);
  await registerModuleHooks(client, modules, buildCommandContext());
  registerBackendSocketBridge(client, { modules, commands });

  return {
    client,
    async start() {
      const token = process.env.DISCORD_TOKEN;
      if (!token) {
        Log.warn('Discord Bot', 'DISCORD_TOKEN not provided. Bot will not connect.');
        return;
      }
      await client.login(token);
    }
  };
}

let client = null;

async function start() {
  const bot = await createDiscordBot();
  client = bot.client;
  return bot.start();
}

process.on('uncaughtException', (err) => {
  if (isRecoverableInteractionError(err)) {
    Log.warn('Discord Bot', `Ignoring recoverable interaction error: ${err.message}`);
    return;
  }
  Log.error('Discord Bot', 'Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (isRecoverableInteractionError(err)) {
    Log.warn('Discord Bot', `Ignoring recoverable interaction rejection: ${err.message}`);
    return;
  }
  Log.error('Discord Bot', 'Unhandled rejection:', err);
});

if (require.main === module) {
  start().catch((err) => {
    Log.error('Discord Bot', 'Failed to start:', err);
    process.exit(1);
  });
}

module.exports = {
  start,
  sendToChannel,
  get client() {
    return client;
  }
};
