const { getAllowlistEligibility } = require('../../allowlistPolicy');
const { sendUsernameChangeReview } = require('../../usernameChangeReview');
const botConfig = require('../../config');
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

  async execute(interaction, { backend, getAutoAllowlistServers }) {
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

    if (existingByDiscord?.minecraftUsername) {
      const review = await sendUsernameChangeReview(interaction.client, botConfig.channels?.usernameChangeReview, {
        user: interaction.user,
        oldUsername: existingByDiscord.minecraftUsername,
        newUsername: minecraftUsername
      });
      await safeReply(interaction, { content: review.message });
      return;
    }

    const result = await backend.setMinecraftUsername(interaction.user.id, minecraftUsername);
    const autoAllowlistServers = getAutoAllowlistServers();
    const allowlistResults = [];

    for (const server of autoAllowlistServers) {
      try {
        const eligibility = await getAllowlistEligibility(server, interaction.guild, interaction.user.id);
        if (!eligibility.allowed) {
          allowlistResults.push(`${server.name}: ${eligibility.reason}`);
          continue;
        }
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
