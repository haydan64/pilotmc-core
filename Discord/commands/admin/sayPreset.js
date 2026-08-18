// /commands/sayPreset.js
// Loads a preset JSON file from ./presetMessages/<presetName>.json and sends it.
// Presets are full Discord API payloads (content/embeds/components/etc.)

const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('saypreset')
    .setDescription('Send a preset message as the bot in this channel (Admin only)')
    .addStringOption((opt) =>
      opt
        .setName('preset')
        .setDescription('Preset filename (without .json).')
        .setRequired(true)
    ),

  async execute(interaction, { ensureRole, roleIds }) {
    const allowed = await ensureRole(
      interaction,
      [roleIds.ADMIN],
      'Only Admin can make the bot send preset messages.'
    );
    if (!allowed) return;

    const presetName = interaction.options.getString('preset', true);

    // Lock presets to the presetMessages folder and force .json
    const presetsDir = path.resolve(process.cwd(), 'presetMessages');
    const presetPath = path.resolve(presetsDir, `${presetName}.json`);
    if (!presetPath.startsWith(presetsDir + path.sep)) {
      return interaction.reply({ content: 'Invalid preset name.', ephemeral: true });
    }

    if (!fs.existsSync(presetPath)) {
      return interaction.reply({
        content: `Preset not found: \`${presetName}.json\``,
        ephemeral: true
      });
    }

    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
    } catch (err) {
      return interaction.reply({
        content: `Preset JSON is invalid: \`${presetName}.json\``,
        ephemeral: true
      });
    }

    // Optional: prevent @everyone/@here pings from presets
    payload.allowedMentions = payload.allowedMentions ?? { parse: [] };

    try {
      await interaction.channel.send(payload);
      await interaction.reply({ content: 'Message sent in this channel.', ephemeral: true });
    } catch (err) {
      await interaction.reply({
        content: `Failed to send preset. Make sure the JSON matches Discord's message format.`,
        ephemeral: true
      });
    }
  }
};
