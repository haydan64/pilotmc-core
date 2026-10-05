const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { safeReply } = require('./commands/interactionResponses');
const Log = require('./log');
const botConfig = require('./config');
const { listMinecraftServers } = require('./minecraftServers');
const { getAllowlistPolicy, getAllowlistEligibility } = require('./allowlistPolicy');

const APPROVE_PREFIX = 'mcname-approve';
const DENY_PREFIX = 'mcname-deny';

function sameUsername(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function buildUsernameChangeReview({ user, oldUsername, newUsername }) {
  const encodedUsername = encodeURIComponent(newUsername);
  if (`${APPROVE_PREFIX}:${user.id}:${encodedUsername}`.length > 100) {
    throw new Error('The Minecraft username is too long for a review request.');
  }
  const embed = new EmbedBuilder()
    .setTitle('Minecraft Username Change Request')
    .setDescription(`Player: <@${user.id}>`)
    .addFields(
      { name: 'Old username', value: oldUsername || '*None*', inline: true },
      { name: 'New username', value: newUsername, inline: true }
    )
    .setColor(0xf0ad4e)
    .setTimestamp();

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPROVE_PREFIX}:${user.id}:${encodedUsername}`)
        .setLabel('Accept')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${DENY_PREFIX}:${user.id}:${encodedUsername}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
    )
  ];

  return { embeds: [embed], components };
}

async function sendUsernameChangeReview(client, channelId, payload) {
  if (!channelId) return { ok: false, message: 'The staff username review channel is not configured. Your username has not changed.' };
  const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) {
    return { ok: false, message: 'Could not find the staff review channel for username changes.' };
  }

  await channel.send(buildUsernameChangeReview(payload));
  return { ok: true, message: `Sent username change request for **${payload.newUsername}** to staff review.` };
}

function registerUsernameChangeReview(client, helpers) {
  const { ensureRole, roleIds, backend } = helpers;
  const processing = new Set();

  client.on('interactionCreate', async (interaction) => {
    let locked = false;
    try {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith(`${APPROVE_PREFIX}:`) && !interaction.customId.startsWith(`${DENY_PREFIX}:`)) {
        return;
      }

      if (interaction.channelId !== botConfig.channels?.usernameChangeReview
        || interaction.message?.author?.id !== client.user?.id) return;
      if (processing.has(interaction.message.id)) {
        await safeReply(interaction, { content: 'This request is already being reviewed.', ephemeral: true });
        return;
      }
      processing.add(interaction.message.id);
      locked = true;
      const allowed = await ensureRole(
        interaction,
        [roleIds?.STAFF, roleIds?.ADMIN, roleIds?.DEVELOPER].filter(Boolean),
        'Only staff can review username changes.'
      );
      if (!allowed) return;

      const [action, targetUserId, encodedUsername] = interaction.customId.split(':');
      const newUsername = decodeURIComponent(encodedUsername || '').trim();
      const approved = action === APPROVE_PREFIX;

      if (!targetUserId || !newUsername) {
        await safeReply(interaction, { content: 'This username change request is malformed.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);

      if (!approved) {
        await interaction.message?.edit({ components: [] }).catch(() => null);
        if (targetUser) {
          await targetUser
            .send(`Your Minecraft username change request to **${newUsername}** was denied.`)
            .catch(() => null);
        }
        await safeReply(interaction, { content: `Denied username change request for <@${targetUserId}>.` });
        return;
      }

      const current = await backend.getPlayerByDiscordUserId(targetUserId).then((result) => result.player);
      const oldUsername = interaction.message.embeds[0]?.fields?.find((field) => field.name === 'Old username')?.value;
      if (!sameUsername(current?.minecraftUsername, oldUsername)) {
        await interaction.message.edit({ components: [] });
        await safeReply(interaction, { content: 'This request is stale because the saved username has changed.' });
        return;
      }
      const existingProfile = await backend.getPlayerByMinecraftUsername(newUsername)
        .then((result) => result.player).catch((err) => {
          if (err.statusCode === 404) return null;
          throw err;
        });
      if (existingProfile && existingProfile.discordUserId !== targetUserId) {
        await safeReply(interaction, { content: `**${newUsername}** is already linked to another Discord user.` });
        return;
      }

      const profile = await backend.getPlayerProfile(targetUserId);
      const refresh = [];
      for (const server of listMinecraftServers()) {
        const prior = profile.servers.find((entry) => entry.serverKey === server.key);
        if (!prior?.available) throw new Error(`Cannot verify the existing allowlist on ${server.name || server.key}. Retry when it is available.`);
        const eligibility = await getAllowlistEligibility(server, interaction.guild, targetUserId);
        if (eligibility.reason === 'membership_unavailable') throw new Error('Discord membership lookup is unavailable. Retry approval later.');
        const allowlist = prior.profile?.allowlist;
        refresh.push({ server, allowlist, eligible: eligibility.allowed });
      }
      // Restore old access if removing an entry or saving the identity fails.
      const removed = [];
      let result;
      try {
        for (const entry of refresh) {
          if (entry.allowlist?.permitted) {
            await backend.removePlayerFromServerAllowlist(entry.server.key, current.id, interaction.user.id);
            removed.push(entry);
          }
        }
        result = await backend.setMinecraftUsername(targetUserId, newUsername, interaction.user.id);
      } catch (err) {
        const restorationFailures = [];
        for (const { server, allowlist } of removed) {
          try {
            await backend.addPlayerToServerAllowlist(server.key, {
              playerId: current.id,
              ignoresPlayerLimit: Boolean(allowlist.ignoresPlayerLimit),
              actorDiscordUserId: interaction.user.id
            });
          } catch (restoreErr) {
            restorationFailures.push(`${server.key}: ${restoreErr.message}`);
          }
        }
        if (restorationFailures.length) err.message += ` Old allowlist restoration failed: ${restorationFailures.join('; ')}`;
        throw err;
      }
      const results = [];
      for (const { server, allowlist, eligible } of refresh) {
        if (!eligible || (!allowlist?.permitted && !getAllowlistPolicy(server).autoAllowlist)) continue;
        try {
          await backend.addPlayerToServerAllowlist(server.key, {
            playerId: result.player.id,
            ignoresPlayerLimit: Boolean(allowlist?.ignoresPlayerLimit),
            actorDiscordUserId: interaction.user.id
          });
          results.push(`${server.name || server.key}: updated`);
        } catch (err) {
          results.push(`${server.name || server.key}: update failed (${err.message})`);
        }
      }

      await interaction.message?.edit({ components: [] }).catch(() => null);
      if (targetUser) {
        await targetUser
          .send(`Your Minecraft username change request was accepted. Your new username is **${newUsername}**.`)
          .catch(() => null);
      }
      await safeReply(interaction, {
        content: `Accepted username change for <@${targetUserId}>. Allowlists: ${results.join('; ') || 'no eligible servers'}.`
      });
    } catch (err) {
      Log.error('Username Change Review', 'Username change review failed:', err);
      await safeReply(interaction, {
        content: `There was an error reviewing this username change: ${err.message}`,
        ephemeral: true
      });
    } finally {
      if (locked) processing.delete(interaction.message?.id);
    }
  });
}

module.exports = {
  sendUsernameChangeReview,
  registerUsernameChangeReview
};
