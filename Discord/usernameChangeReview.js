const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { isDuplicateMinecraftUsernameError, requestAllowlistUpdate } = require('./commands/minecraftProfileAllowlist');
const { safeReply } = require('./commands/interactionResponses');
const Log = require('../log');

const APPROVE_PREFIX = 'mcname-approve';
const DENY_PREFIX = 'mcname-deny';

function sameUsername(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function buildUsernameChangeReview({ user, oldUsername, newUsername }) {
  const encodedUsername = encodeURIComponent(newUsername);
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
  const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) {
    return { ok: false, message: 'Could not find the staff review channel for username changes.' };
  }

  await channel.send(buildUsernameChangeReview(payload));
  return { ok: true, message: `Sent username change request for **${payload.newUsername}** to staff review.` };
}

function registerUsernameChangeReview(client, helpers) {
  const {
    ensureRole,
    roleIds,
    upsertMinecraftProfile,
    getMinecraftProfileByUsername,
    eventBus,
    events
  } = helpers;

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith(`${APPROVE_PREFIX}:`) && !interaction.customId.startsWith(`${DENY_PREFIX}:`)) {
        return;
      }

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

      const existingProfile = await getMinecraftProfileByUsername(newUsername);
      if (existingProfile && !sameUsername(existingProfile.discord_id, targetUserId)) {
        await safeReply(interaction, {
          content: `Cannot approve this request because **${newUsername}** is already linked to another Discord user.`
        });
        return;
      }

      const result = await upsertMinecraftProfile(targetUserId, newUsername, {
        clearXuidOnUsernameChange: true
      });
      const profile = result?.rows?.[0] || result;
      const allowlistResult = await requestAllowlistUpdate(eventBus, events, profile);

      await interaction.message?.edit({ components: [] }).catch(() => null);
      if (targetUser) {
        await targetUser
          .send(`Your Minecraft username change request was accepted. Your new username is **${newUsername}**.`)
          .catch(() => null);
      }
      await safeReply(interaction, {
        content: `Accepted username change for <@${targetUserId}>. ${allowlistResult.message}`
      });
    } catch (err) {
      if (isDuplicateMinecraftUsernameError(err)) {
        await safeReply(interaction, {
          content: `Cannot approve this request because **${newUsername}** is already linked to another Discord user.`
        });
        return;
      }

      Log.error('Username Change Review', 'Username change review failed:', err);
      await safeReply(interaction, {
        content: `There was an error reviewing this username change: ${err.message}`,
        ephemeral: true
      });
    }
  });
}

module.exports = {
  sendUsernameChangeReview,
  registerUsernameChangeReview
};
