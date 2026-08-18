const { SlashCommandBuilder } = require('discord.js');
const { safeReply } = require('../interactionResponses');
const { listMinecraftServers } = require('../../minecraftServers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removeminecraftusername')
    .setDescription("Remove a player's linked Minecraft username (Staff only)")
    .addUserOption((opt) => opt.setName('user').setDescription('Discord user').setRequired(true)),

  async execute(interaction, { backend, ensureRole, roleIds, formatUser }) {
    const allowed = await ensureRole(
      interaction,
      [roleIds.STAFF, roleIds.ADMIN, roleIds.DEVELOPER],
      'Only staff can remove linked Minecraft usernames.'
    );
    if (!allowed) return;

    const user = interaction.options.getUser('user', true);
    await interaction.deferReply({ ephemeral: true });

    const playerResult = await backend.getPlayerByDiscordUserId(user.id);
    const player = playerResult.player;
    const servers = listMinecraftServers();
    const allowlistResults = [];

    for (const server of servers) {
      try {
        await backend.removePlayerFromServerAllowlist(server.key, player.id, interaction.user.id);
        allowlistResults.push(`${server.name || server.key}: removed`);
      } catch (err) {
        allowlistResults.push(`${server.name || server.key}: ${err.message}`);
      }
    }

    const result = await backend.removeMinecraftUsername(user.id, interaction.user.id);
    await safeReply(interaction, {
      content:
        `Removed linked Minecraft username **${result.previousPlayer.minecraftUsername || 'unknown'}** from ${formatUser(user)}. ` +
        `Allowlists: ${allowlistResults.join('; ') || 'no servers configured'}.`
    });
  }
};
