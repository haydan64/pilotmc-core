const { SlashCommandBuilder } = require('discord.js');
const { safeReply } = require('../interactionResponses');
const { listMinecraftServers } = require('../../minecraftServers');

function sameUsername(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('changeplayerusername')
    .setDescription("Change a player's Minecraft username (Admin only)")
    .addUserOption((opt) => opt.setName('user').setDescription('Discord user').setRequired(true))
    .addStringOption((opt) => opt.setName('username').setDescription('New Minecraft username').setRequired(true)),
  async execute(interaction, { ensureRole, roleIds, backend, formatUser }) {
    const allowed = await ensureRole(interaction, [roleIds.ADMIN], 'Only Admin can change player usernames.');
    if (!allowed) return;

    const user = interaction.options.getUser('user', true);
    const username = interaction.options.getString('username', true).trim();
    if (!username) {
      await interaction.reply({ content: 'Please provide a valid username.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const previousProfile = await backend.getPlayerByDiscordUserId(user.id).then((result) => result.player).catch((err) => {
      if (err.statusCode === 404) return null;
      throw err;
    });
    const conflictingProfile = await backend.getPlayerByMinecraftUsername(username).then((result) => result.player).catch((err) => {
      if (err.statusCode === 404) return null;
      throw err;
    });
    if (conflictingProfile && conflictingProfile.discordUserId !== user.id) {
      await safeReply(interaction, {
        content: `**${username}** is already linked to another Discord user.`,
      });
      return;
    }

    const usernameChanged = previousProfile?.minecraftUsername && !sameUsername(previousProfile.minecraftUsername, username);
    const servers = listMinecraftServers();
    const refreshResults = [];
    if (usernameChanged && previousProfile?.id) {
      for (const server of servers) {
        await backend.removePlayerFromServerAllowlist(server.key, previousProfile.id, interaction.user.id).catch(() => null);
      }
    }

    const result = await backend.setMinecraftUsername(user.id, username);
    for (const server of servers) {
      try {
        await backend.addPlayerToServerAllowlist(server.key, {
          playerId: result.player.id,
          permitted: true,
          ignoresPlayerLimit: false,
          actorDiscordUserId: interaction.user.id
        });
        refreshResults.push(`${server.name || server.key}: updated`);
      } catch (err) {
        refreshResults.push(`${server.name || server.key}: ${err.message}`);
      }
    }

    await safeReply(interaction, {
      content: `Updated Minecraft username for ${formatUser(user)} to **${result.player.minecraftUsername}** and refreshed allowlists: ${refreshResults.join('; ') || 'no servers configured'}.`
    });
  }
};
