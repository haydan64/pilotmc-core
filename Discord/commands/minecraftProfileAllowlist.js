function getReturnedRow(result) {
  return result?.rows?.[0] || result || null;
}

function sameUsername(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function isDuplicateMinecraftUsernameError(err) {
  return err?.code === '23505' && err?.constraint === 'players_username_lower_idx';
}

async function requestAllowlistUpdate(eventBus, events, profile, options = {}) {
  if (!profile?.username) return { ok: false, message: 'Cannot update allowlist without a saved Minecraft username.' };
  return eventBus.request(events.SERVER_COMMAND, {
    action: 'allowlist:add',
    name: profile.username,
    xuid: profile.xuid || null,
    ignoresPlayerLimit: Boolean(options.ignoresPlayerLimit)
  });
}

async function requestAllowlistRemoval(eventBus, events, username) {
  if (!username) return { ok: false, message: 'Cannot remove allowlist entry without a Minecraft username.' };
  return eventBus.request(events.SERVER_COMMAND, { action: 'allowlist:remove', name: username });
}

async function saveProfileAndQueueAllowlist({
  discordId,
  username,
  getMinecraftProfileByDiscordId,
  upsertMinecraftProfile,
  eventBus,
  events
}) {
  const previousProfile = await getMinecraftProfileByDiscordId(discordId);
  const result = await upsertMinecraftProfile(discordId, username, {
    clearXuidOnUsernameChange: true
  });
  const profile = getReturnedRow(result);

  const oldUsername = previousProfile?.username;
  let removalResult = null;
  if (oldUsername && !sameUsername(oldUsername, profile?.username)) {
    removalResult = await requestAllowlistRemoval(eventBus, events, oldUsername);
  }

  const allowlistResult = await requestAllowlistUpdate(eventBus, events, profile);

  return {
    profile,
    previousProfile,
    removedOldUsername: oldUsername && !sameUsername(oldUsername, profile?.username) ? oldUsername : null,
    removalResult,
    allowlistResult
  };
}

module.exports = {
  isDuplicateMinecraftUsernameError,
  requestAllowlistUpdate,
  requestAllowlistRemoval,
  saveProfileAndQueueAllowlist
};
