const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { addMinecraftServerOption } = require('../../minecraftServers');

module.exports = {
  data: addMinecraftServerOption(
    new SlashCommandBuilder()
      .setName('restartbds')
      .setDescription('Restart a Bedrock server gracefully')
  ),
  async execute(interaction, { ensureRole, roleIds, backend }) {
    const allowed = await ensureRole(interaction, [roleIds.ADMIN], 'Only Admin can restart the server.');
    if (!allowed) return;

    const serverKey = interaction.options.getString('server', true);
    await replyWithRequestResult(interaction, backend.sendServerCommand(serverKey, { action: 'restart' }, interaction.user.id));
  }
};
