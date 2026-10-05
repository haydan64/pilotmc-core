function getAllowlistPolicy(server = {}) {
  return {
    autoAllowlist: server.allowlist?.autoAllowlist ?? Boolean(server.autoAllowlistOnSetMinecraftUsername),
    requiredRoleIds: server.allowlist?.requiredRoleIds || [],
    blockedRoleIds: server.allowlist?.blockedRoleIds || [],
    requireDiscordMembership: server.allowlist?.requireDiscordMembership ?? false,
    removeOnDiscordLeave: server.allowlist?.removeOnDiscordLeave ?? false
  };
}

function checkAllowlistRoles(policy, member) {
  const hasRole = (id) => Boolean(member?.roles?.cache?.has(id));
  if (policy.blockedRoleIds.some(hasRole)) return { allowed: false, reason: 'blocked_role' };
  if (policy.requiredRoleIds.length && !policy.requiredRoleIds.some(hasRole)) {
    return { allowed: false, reason: 'missing_required_role' };
  }
  if (policy.requireDiscordMembership && !member) return { allowed: false, reason: 'not_in_discord' };
  return { allowed: true, reason: 'allowlist_policy' };
}

async function getAllowlistEligibility(server, guild, discordUserId) {
  const policy = getAllowlistPolicy(server);
  if (!policy.requireDiscordMembership && !policy.requiredRoleIds.length && !policy.blockedRoleIds.length) {
    return { allowed: true, reason: 'unrestricted' };
  }
  if (!guild || !discordUserId) return { allowed: false, reason: 'membership_unavailable' };
  let member;
  try {
    member = await guild.members.fetch({ user: discordUserId, force: true });
  } catch (err) {
    if (err.code !== 10007) return { allowed: false, reason: 'membership_unavailable' };
    member = null;
  }
  return checkAllowlistRoles(policy, member);
}

module.exports = { getAllowlistPolicy, checkAllowlistRoles, getAllowlistEligibility };
