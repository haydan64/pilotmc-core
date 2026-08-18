const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function formatDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function formatServer(server) {
  if (!server.available) {
    return `**${server.displayName || server.serverKey}**: unavailable (${server.error || 'agent offline'})`;
  }

  const profile = server.profile || {};
  const allowlist = profile.allowlist;
  const state = profile.state;
  const permission = profile.permission;
  const pieces = [];

  pieces.push(allowlist?.permitted ? 'allowlisted' : 'not allowlisted');
  if (allowlist?.ignoresPlayerLimit) pieces.push('ignores player limit');
  if (permission?.permission) pieces.push(`permission: ${permission.permission}`);

  if (state?.lastKnownOnline) {
    pieces.push('online now');
  } else if (state?.lastLeftAt) {
    pieces.push(`last seen ${formatDate(state.lastLeftAt)}`);
  } else if (state?.lastJoinedAt) {
    pieces.push(`last joined ${formatDate(state.lastJoinedAt)}`);
  }

  return `**${server.displayName || server.serverKey}**: ${pieces.join('; ')}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View a player profile')
    .addUserOption((opt) => opt.setName('user').setDescription('Player to view').setRequired(true)),

  async execute(interaction, { backend, ensureRole, roleIds, formatUser }) {
    const allowed = await ensureRole(
      interaction,
      [roleIds.STAFF, roleIds.ADMIN, roleIds.DEVELOPER],
      'Only staff can view player profiles.'
    );
    if (!allowed) return;

    const user = interaction.options.getUser('user', true);
    await interaction.deferReply({ ephemeral: true });

    const profile = await backend.getPlayerProfile(user.id);
    const player = profile.player;
    const minecraftDetails = player
      ? [
          `Minecraft: **${player.minecraftUsername}**`,
          `XUID: ${player.xuid || 'Unknown'}`,
          `Player ID: ${player.id}`
        ].join('\n')
      : 'No Minecraft username is linked yet.';

    const servers = profile.servers || [];
    const onlineServers = servers
      .filter((server) => server.available && server.profile?.state?.lastKnownOnline)
      .map((server) => server.displayName || server.serverKey);

    const embed = new EmbedBuilder()
      .setTitle(`Profile: ${formatUser(user)}`)
      .setDescription(`Discord: <@${user.id}>`)
      .addFields(
        { name: 'Minecraft', value: minecraftDetails, inline: false },
        {
          name: 'Online',
          value: onlineServers.length ? onlineServers.join(', ') : 'Not currently online on a tracked server.',
          inline: false
        },
        {
          name: 'Servers',
          value: servers.length ? servers.map(formatServer).join('\n') : 'No Minecraft servers configured.',
          inline: false
        }
      )
      .setColor(0x5865f2)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};
