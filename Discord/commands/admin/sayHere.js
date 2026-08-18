const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sayhere')
    .setDescription('Send a message as the bot in this channel (Admin only)')
    .addStringOption((opt) => opt.setName('message').setDescription('Message to send').setRequired(true)),
  async execute(interaction, { ensureRole, roleIds }) {
    const allowed = await ensureRole(interaction, [roleIds.ADMIN], 'Only Admin can speak through the bot.');
    if (!allowed) return;

    const message = interaction.options.getString('message', true);
    await interaction.channel.send({ content: message });
    await interaction.reply({ content: 'Message sent in this channel.', ephemeral: true });
  }
};
