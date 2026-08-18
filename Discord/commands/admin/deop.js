const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { addMinecraftServerOption } = require('../../minecraftServers');

async function resolveXuid(player, backend) {
  const trimmed = player?.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;

  const profile = await backend.getPlayerByMinecraftUsername(trimmed).then((result) => result.player).catch(() => null);
  if (profile?.xuid) return profile.xuid;

  return null;
}

module.exports = {
  data: addMinecraftServerOption(
    new SlashCommandBuilder()
      .setName('deop')
      .setDescription('Demote a player to member and persist the change')
      .addStringOption((opt) => opt.setName('player').setDescription('Player name or XUID').setRequired(true))
  ),
  async execute(interaction, { ensureRole, roleIds, backend }) {
    const allowed = await ensureRole(interaction, [roleIds.ADMIN], 'Only Admin can demote operators.');
    if (!allowed) return;

    const player = interaction.options.getString('player', true);
    const serverKey = interaction.options.getString('server', true);
    const xuid = await resolveXuid(player, backend);
    if (!xuid) {
      await interaction.reply({
        content: 'Could not resolve a valid XUID for that player. Please provide a XUID or add one to the database first.',
        ephemeral: true
      });
      return;
    }

    await replyWithRequestResult(
      interaction,
      backend.sendServerCommand(serverKey, { action: 'permission:set', xuid, permission: 'member' }, interaction.user.id)
    );
  }
};
