const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { addMinecraftServerOption } = require('../../minecraftServers');

module.exports = {
  data: addMinecraftServerOption(
    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a player from a Bedrock server')
      .addStringOption((opt) =>
        opt.setName('player').setDescription('Player name or XUID').setRequired(true)
      )
      .addStringOption((opt) => opt.setName('reason').setDescription('Reason for the kick').setRequired(true))
  ),
  async execute(interaction, { ensureRole, roleIds, backend }) {
    const allowed = await ensureRole(interaction, [roleIds.ADMIN], 'Only Admin can kick players.');
    if (!allowed) return;

    const player = interaction.options.getString('player', true);
    const reason = interaction.options.getString('reason', true);
    const serverKey = interaction.options.getString('server', true);
    const sanitizedReason = reason.replace(/"/g, "'");
    await replyWithRequestResult(interaction, backend.sendServerCommand(serverKey, {
      action: 'command',
      command: `kick "${player}" ${sanitizedReason}`
    }, interaction.user.id));
  }
};
