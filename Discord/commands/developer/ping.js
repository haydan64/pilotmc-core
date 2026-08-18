const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Ping the bot (developers only)'),
  async execute(interaction, { ensureRole, roleIds }) {
    const allowed = await ensureRole(interaction, [roleIds.DEVELOPER], 'Only developers can use /ping.');
    if (!allowed) return;

    const sent = await interaction.reply({ content: 'Pong!', ephemeral: true, fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.followUp({ content: `Round-trip latency: ${latency}ms`, ephemeral: true });
  }
};
