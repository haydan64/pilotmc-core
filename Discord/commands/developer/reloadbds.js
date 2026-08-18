const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { addMinecraftServerOption } = require('../../minecraftServers');

module.exports = {
  data: addMinecraftServerOption(
    new SlashCommandBuilder()
      .setName('reloadbds')
      .setDescription('Reload addons on a Bedrock server')
  ),
  async execute(interaction, { ensureRole, roleIds, backend }) {
    const allowed = await ensureRole(
      interaction,
      [roleIds.DEVELOPER],
      'Only developers can reload the addons on the bds.'
    );
    if (!allowed) return;

    const serverKey = interaction.options.getString('server', true);
    await replyWithRequestResult(interaction, backend.sendServerCommand(serverKey, { action: 'reload' }, interaction.user.id));
  }
};
