const { getAllowlistEligibility } = require('../../allowlistPolicy');
const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { listMinecraftServers } = require('../../minecraftServers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('allowlist')
    .setDescription('Allowlist a community member on a Minecraft server')
    .addStringOption((opt) => {
      opt.setName('server').setDescription('Minecraft server').setRequired(true);
      for (const server of listMinecraftServers()) {
        opt.addChoices({ name: server.name, value: server.key });
      }
      return opt;
    })
    .addUserOption((opt) => opt.setName('user').setDescription('Discord user to allowlist').setRequired(true))
      .addBooleanOption((opt) =>
        opt
          .setName('ignores-player-limit')
          .setDescription('Allow this player to join even when the server is full')
          .setRequired(false)
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
    const ignoresPlayerLimit = Boolean(interaction.options.getBoolean('ignores-player-limit') || false);

    const server = listMinecraftServers().find((entry) => entry.key === serverKey);
    if (!server) {
      await interaction.reply({ content: 'This server is not configured.', ephemeral: true });
      return;
    }
    const eligibility = await getAllowlistEligibility(server, interaction.guild, user.id);
    if (!eligibility.allowed) {
      await interaction.reply({ content: `Cannot allowlist this player: ${eligibility.reason}.`, ephemeral: true });
      return;
    }
    await replyWithRequestResult(
      interaction,
      backend.addPlayerToServerAllowlist(serverKey, {
        discordUserId: user.id,
        permitted: true,
        ignoresPlayerLimit,
        actorDiscordUserId: interaction.user.id
      }),
      {
        successMessage: `Allowlist updated for ${formatUser(user)}.`
      }
    );
  }
};
