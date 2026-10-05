const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } = require('discord.js');
const Log = require('./log');
const { safeReply } = require('./commands/interactionResponses');
const fs = require('fs');
const path = require('path');
const { getMinecraftServer } = require('./minecraftServers');
const { getAllowlistEligibility } = require('./allowlistPolicy');
const configPath = path.join(__dirname, 'serverListings.json');
const listings = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : [];

function listingPayload(server) {
  const message = server.message || {};
  if (typeof message.content !== 'undefined' && typeof message.content !== 'string') throw new Error(`${server.key}: message.content must be a string.`);
  if ((message.content || '').length > 2000) throw new Error(`${server.key}: message.content exceeds 2000 characters.`);
  if (message.embeds && !Array.isArray(message.embeds)) throw new Error(`${server.key}: message.embeds must be an array.`);
  const embeds = (message.embeds || []).map(embed => new EmbedBuilder(embed).toJSON());
  if (embeds.length > 10) throw new Error(`${server.key}: at most 10 embeds are allowed.`);
  const embedLength = embeds.reduce((total, embed) => total + (embed.title || '').length + (embed.description || '').length
    + (embed.footer?.text || '').length + (embed.author?.name || '').length
    + (embed.fields || []).reduce((sum, field) => sum + field.name.length + field.value.length, 0), 0);
  if (embedLength > 6000) throw new Error(`${server.key}: combined embed text exceeds 6000 characters.`);
  return {
    content: message.content || '',
    embeds,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`server-whitelist:${server.key}`).setLabel(server.buttonLabel || 'Get Whitelisted').setStyle(ButtonStyle.Success))],
    allowedMentions: { parse: [] }
  };
}

async function checkEligibility(server, interaction, backend) {
  const configuredServer = getMinecraftServer(server.key);
  if (!configuredServer) return 'This Minecraft server is no longer configured.';
  const eligibility = await getAllowlistEligibility(configuredServer, interaction.guild, interaction.user.id);
  if (!eligibility.allowed) return `You cannot access this server: ${eligibility.reason}.`;
  if (server.requiredRoleId) {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member.roles.cache.has(server.requiredRoleId)) return 'You do not have the required role for this listing.';
  }
  if (server.requiresAcceptedApplication) {
    const application = await backend.getApplication(interaction.user.id);
    if (application?.application?.status !== 'accepted') return 'Your application must be accepted before you can be whitelisted.';
  }
  return null;
}

function usernameModal(server) {
  return new ModalBuilder().setCustomId(`server-whitelist-name:${server.key}`).setTitle('Link your Minecraft account')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username')
      .setLabel('Your exact Minecraft username').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32)));
}

function registerServerListings(client, backend) {
  client.once('clientReady', async () => {
    for (const server of listings) {
      try {
        const channel = await client.channels.fetch(server.channelId);
        if (!channel?.isTextBased()) throw new Error('Server listing channel is unavailable.');
        const messages = await channel.messages.fetch({ limit: 100 });
        const existing = messages.find(m => m.author.id === client.user.id && m.components.some(row => row.components.some(c => c.customId === `server-whitelist:${server.key}`)));
        if (existing) await existing.edit(listingPayload(server));
        else await channel.send(listingPayload(server));
        Log.info('Server Listings', `Listing ready for ${server.key}.`);
      } catch (err) { Log.error('Server Listings', `Could not publish ${server.key}:`, err); }
    }
  });
  client.on('interactionCreate', async interaction => {
    const id = interaction.customId || '';
    if (!id.startsWith('server-whitelist:') && !id.startsWith('server-whitelist-name:') && !id.startsWith('server-whitelist-link:')) return;
    const server = listings.find(s => s.key === id.split(':')[1]);
    try {
      if (!server || !interaction.guild || interaction.channelId !== server.channelId) {
        await interaction.reply({ content: 'This server listing is no longer available.', ephemeral: true }); return;
      }
      // Modal opening must be immediate; eligibility is checked before saving or granting access.
      if (id.startsWith('server-whitelist-link:')) {
        await interaction.showModal(usernameModal(server)); return;
      }
      await interaction.deferReply({ ephemeral: true });
      const profile = await backend.getPlayerProfile(interaction.user.id);
      const existingAccess = profile.servers?.find(entry => entry.serverKey === server.key);
      if (existingAccess?.available && existingAccess.profile?.allowlist?.permitted === true) {
        await interaction.editReply({
          content: `You are already whitelisted on **${server.name}**.`,
          allowedMentions: { parse: [] },
          components: []
        });
        return;
      }
      const denied = await checkEligibility(server, interaction, backend);
      if (denied) { await interaction.editReply({ content: denied, allowedMentions: { parse: [] } }); return; }
      let player;
      try { player = (await backend.getPlayerByDiscordUserId(interaction.user.id))?.player; }
      catch (err) { if (err.statusCode !== 404) throw err; }
      if (id.startsWith('server-whitelist-name:')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        if (!username) throw new Error('Enter your Minecraft username.');
        if (player?.minecraftUsername && player.minecraftUsername.toLowerCase() !== username.toLowerCase()) {
          await interaction.editReply({ content: 'You already have a different Minecraft username linked. Ask staff to update it.' }); return;
        }
        let owner;
        try { owner = (await backend.getPlayerByMinecraftUsername(username))?.player; }
        catch (err) { if (err.statusCode !== 404) throw err; }
        if (owner && owner.discordUserId !== interaction.user.id) {
          await interaction.editReply({ content: 'That Minecraft username is linked to another Discord account.' }); return;
        }
        player = (await backend.setMinecraftUsername(interaction.user.id, username))?.player;
      }
      if (!player?.minecraftUsername) {
        await interaction.editReply({ content: 'Link your Minecraft username first, then you can join this server.', components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`server-whitelist-link:${server.key}`).setLabel('Enter Minecraft Username').setStyle(ButtonStyle.Primary))] }); return;
      }
      await backend.addPlayerToServerAllowlist(server.key, { discordUserId: interaction.user.id, permitted: true, ignoresPlayerLimit: false, actorDiscordUserId: interaction.user.id });
      await interaction.editReply({ content: `You are whitelisted on **${server.name}** as **${player.minecraftUsername}**.`, allowedMentions: { parse: [] }, components: [] });
    } catch (err) {
      Log.error('Server Listings', `Whitelist failed for ${server?.key || 'unknown'} / ${interaction.user.id}:`, err);
      await safeReply(interaction, { content: 'Could not complete whitelisting. Please try again or ask staff for help.', ephemeral: true, components: [] });
    }
  });
}

module.exports = { registerServerListings, checkEligibility, listingPayload };
