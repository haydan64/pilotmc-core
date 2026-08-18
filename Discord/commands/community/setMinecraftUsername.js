const { SlashCommandBuilder } = require('discord.js');
const { safeReply } = require('../interactionResponses');

function sameUsername(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function isNotFoundError(err) {
  return err?.statusCode === 404;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setminecraftusername')
    .setDescription('Set your Minecraft username')
    .addStringOption((opt) => opt.setName('username').setDescription('Your Minecraft username').setRequired(true)),

  async execute(interaction, { backend, rolesConfig, getAutoAllowlistServers }) {
    const memberRoles = interaction.member?.roles?.cache;
    if (rolesConfig?.member && !memberRoles?.has(rolesConfig.member)) {
      await interaction.reply({
        content: 'Only players with the Member role can use this command.',
        ephemeral: true
      });
      return;
    }

    const minecraftUsername = interaction.options.getString('username', true).trim();
    if (!minecraftUsername) {
      await interaction.reply({ content: 'Please provide a valid username.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const existingByDiscord = await backend
      .getPlayerByDiscordUserId(interaction.user.id)
      .then((result) => result.player)
      .catch((err) => {
        if (isNotFoundError(err)) return null;
        throw err;
      });

    if (sameUsername(existingByDiscord?.minecraftUsername, minecraftUsername)) {
      await safeReply(interaction, {
        content: `Your Minecraft username is already set to **${existingByDiscord.minecraftUsername}**.`
      });
      return;
    }

    const existingByUsername = await backend
      .getPlayerByMinecraftUsername(minecraftUsername)
      .then((result) => result.player)
      .catch((err) => {
        if (isNotFoundError(err)) return null;
        throw err;
      });

    if (existingByUsername && existingByUsername.discordUserId !== interaction.user.id) {
      await safeReply(interaction, {
        content: `**${minecraftUsername}** is already linked to another Discord user. Please enter your own Minecraft username.`
      });
      return;
    }

    const result = await backend.setMinecraftUsername(interaction.user.id, minecraftUsername);
    const autoAllowlistServers = getAutoAllowlistServers();
    const allowlistResults = [];

    for (const server of autoAllowlistServers) {
      try {
        await backend.addPlayerToServerAllowlist(server.key, {
          discordUserId: interaction.user.id,
          permitted: true,
          ignoresPlayerLimit: false
        });
        allowlistResults.push(`${server.name}: added`);
      } catch (err) {
        allowlistResults.push(`${server.name}: ${err.message}`);
      }
    }

    const allowlistMessage = allowlistResults.length
      ? ` Auto-allowlist: ${allowlistResults.join('; ')}.`
      : '';

    await safeReply(interaction, {
      content: `Saved your Minecraft username as **${result.player.minecraftUsername}**.${allowlistMessage} We'll capture your XUID when you join a Minecraft server.`
    });
  }
};
