const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { addMinecraftServerOption } = require('../../minecraftServers');

module.exports = {
  data: addMinecraftServerOption(
    new SlashCommandBuilder()
      .setName('sendmessage')
      .setDescription('Send a message to a Minecraft server')
      .addStringOption((opt) =>
        opt.setName('message').setDescription('Message to broadcast to the server').setRequired(true)
      )
  ),
  async execute(interaction, { ensureRole, roleIds, backend }) {
    const allowed = await ensureRole(interaction, [roleIds.ADMIN], 'Only Admin can send server messages.');
    if (!allowed) return;

    const message = interaction.options.getString('message', true);
    const serverKey = interaction.options.getString('server', true);
    await replyWithRequestResult(
      interaction,
      backend.sendServerCommand(serverKey, { action: 'command', command: `say ${message}` }, interaction.user.id)
    );
  }
};
