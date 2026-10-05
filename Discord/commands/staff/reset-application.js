const { SlashCommandBuilder } = require('discord.js');
const { clearApplicationDraft } = require('../../applicationForms');
const config = require('../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reset-application')
    .setDescription("Clear a player's application and restore their applicant role")
    .addUserOption(option => option.setName('user').setDescription('Player to reset').setRequired(true)),
  async execute(interaction, { backend, ensureRole, roleIds, rolesConfig }) {
    if (!await ensureRole(interaction, [roleIds.STAFF, roleIds.ADMIN, roleIds.DEVELOPER].filter(Boolean), 'Only staff can reset applications.')) return;
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user', true);
    const member = await interaction.guild.members.fetch(user.id);
    await backend.resetApplication(user.id, interaction.user.id);
    clearApplicationDraft(user.id);
    const failures = [];
    if (rolesConfig.member && member.roles.cache.has(rolesConfig.member)) {
      await member.roles.remove(rolesConfig.member).catch(err => failures.push(`Could not remove the member role: ${err.message}`));
    }
    if (rolesConfig.guest && !member.roles.cache.has(rolesConfig.guest)) {
      await member.roles.add(rolesConfig.guest).catch(err => failures.push(`Could not add the applicant role: ${err.message}`));
    }
    await interaction.editReply({
      content: `Reset the application and cleared saved answers for <@${user.id}>. They can start again using <#${config.channels.applyHere}>.${failures.length ? `\n${failures.join('\n')}` : '\nApplicant roles restored.'}`,
      allowedMentions: { parse: [] }
    });
  }
};
