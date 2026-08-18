const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { addMinecraftServerOption } = require('../../minecraftServers');

module.exports = {
  data: addMinecraftServerOption(
    new SlashCommandBuilder()
      .setName('forcestopbds')
      .setDescription('Force stop a Bedrock server')
  ),
  async execute(interaction, { ensureRole, roleIds, backend }) {
    const allowed = await ensureRole(
      interaction,
      [roleIds.DEVELOPER],
      'Only developers can force stop the Bedrock server.'
    );
    if (!allowed) return;

    const serverKey = interaction.options.getString('server', true);
    await replyWithRequestResult(interaction, backend.sendServerCommand(serverKey, { action: 'forceStop' }, interaction.user.id));
  }
};
