const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { addMinecraftServerOption } = require('../../minecraftServers');

module.exports = {
  data: addMinecraftServerOption(
    new SlashCommandBuilder().setName('stopbds').setDescription('Stop a Bedrock server')
  ),
  async execute(interaction, { ensureRole, roleIds, backend }) {
    const allowed = await ensureRole(interaction, [roleIds.ADMIN], 'Only Admin can stop the server.');
    if (!allowed) return;

    const serverKey = interaction.options.getString('server', true);
    await replyWithRequestResult(interaction, backend.sendServerCommand(serverKey, { action: 'stop' }, interaction.user.id));
  }
};
