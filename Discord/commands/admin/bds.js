const { SlashCommandBuilder } = require('discord.js');
const { replyWithRequestResult } = require('../interactionResponses');
const { addMinecraftServerOption } = require('../../minecraftServers');

function addServerAndActionOptions(builder) {
  return addMinecraftServerOption(builder).addStringOption((opt) =>
    opt
      .setName('operation')
      .setDescription('Server action')
      .setRequired(true)
      .addChoices(
        { name: 'start', value: 'start' },
        { name: 'stop', value: 'stop' },
        { name: 'force stop', value: 'forceStop' },
        { name: 'restart', value: 'restart' },
        { name: 'reload', value: 'reload' },
        { name: 'backup', value: 'backup' }
      )
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bds')
    .setDescription('Bedrock server management')
    .addSubcommand((sub) =>
      addServerAndActionOptions(sub.setName('action').setDescription('Run a server lifecycle action'))
    )
    .addSubcommand((sub) =>
      addMinecraftServerOption(
        sub
          .setName('run')
          .setDescription('Run a command on a Minecraft server')
          .addStringOption((opt) =>
            opt.setName('command').setDescription('Command to send to the server').setRequired(true)
        )
      )
    )
    .addSubcommand((sub) =>
      addMinecraftServerOption(
        sub
          .setName('backup-cleanup')
          .setDescription('Pause or resume automatic backup deletion')
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('Whether expired backups may be deleted')
              .setRequired(true)
              .addChoices(
                { name: 'pause deletion', value: 'pause' },
                { name: 'resume deletion', value: 'resume' }
              )
          )
      )
    ),

  async execute(interaction, { backend, ensureRole, roleIds }) {
    const allowed = await ensureRole(interaction, [roleIds.ADMIN, roleIds.DEVELOPER], 'Only Admin can run server commands.');
    if (!allowed) return;

    const subcommand = interaction.options.getSubcommand();
    const serverKey = interaction.options.getString('server', true);

    if (subcommand === 'run') {
      const command = interaction.options.getString('command', true);
      await replyWithRequestResult(
        interaction,
        backend.sendServerCommand(serverKey, { action: 'command', command }, interaction.user.id)
      );
      return;
    }

    if (subcommand === 'action') {
      const action = interaction.options.getString('operation', true);
      await replyWithRequestResult(
        interaction,
        backend.sendServerCommand(serverKey, { action }, interaction.user.id)
      );
      return;
    }

    if (subcommand === 'backup-cleanup') {
      const mode = interaction.options.getString('mode', true);
      await replyWithRequestResult(
        interaction,
        backend.sendServerCommand(
          serverKey,
          { action: 'backupCleanup:set', enabled: mode === 'resume' },
          interaction.user.id
        )
      );
      return;
    }

    await interaction.reply({ content: 'Unknown BDS action.', ephemeral: true });
  }
};
