const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { addMinecraftServerOption } = require('../../minecraftServers');

module.exports = {
  data: addMinecraftServerOption(
    new SlashCommandBuilder()
      .setName('unallowlist')
      .setDescription('Remove a community member from a Minecraft server allowlist')
      .addUserOption((opt) => opt.setName('user').setDescription('Discord user to remove').setRequired(true))
  ),

  async execute(interaction, { backend, ensureRole, roleIds, formatUser }) {
    const allowed = await ensureRole(
      interaction,
      [roleIds.STAFF, roleIds.ADMIN, roleIds.DEVELOPER],
      'Only staff can update the allowlist.'
    );
    if (!allowed) return;

    const user = interaction.options.getUser('user', true);
    const serverKey = interaction.options.getString('server', true);

    const playerResult = await backend.getPlayerByDiscordUserId(user.id);
    await replyWithRequestResult(
      interaction,
      backend.removePlayerFromServerAllowlist(serverKey, playerResult.player.id, interaction.user.id),
      {
        successMessage: `Allowlist entry removed for ${formatUser(user)}.`
      }
    );
  }
};
