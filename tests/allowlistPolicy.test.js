const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const policy = require('../Discord/allowlistPolicy');
const member = (...roles) => ({ roles: { cache: new Set(roles) } });
const restricted = policy.getAllowlistPolicy({ allowlist: { requiredRoleIds: ['member', 'staff'], blockedRoleIds: ['blocked'] } });

test('server policy: block wins, any required role suffices, empty lists allow', () => {
  assert.equal(policy.checkAllowlistRoles(restricted, member('staff')).allowed, true);
  assert.equal(policy.checkAllowlistRoles(restricted, member('member', 'blocked')).reason, 'blocked_role');
  assert.equal(policy.checkAllowlistRoles(restricted, member()).allowed, false);
  assert.equal(policy.checkAllowlistRoles(policy.getAllowlistPolicy(), null).allowed, true);
  assert.equal(policy.getAllowlistPolicy({ autoAllowlistOnSetMinecraftUsername: true }).autoAllowlist, true);
  assert.equal(policy.getAllowlistPolicy({ autoAllowlistOnSetMinecraftUsername: true, allowlist: { autoAllowlist: false } }).autoAllowlist, false);
});
test('membership unavailable denies restricted grants; unrestricted grants need no Discord', async () => {
  assert.equal((await policy.getAllowlistEligibility({}, null, null)).allowed, true);
  assert.equal((await policy.getAllowlistEligibility({ allowlist: { requireDiscordMembership: true } }, null, 'user')).allowed, false);
  const guild = { members: { fetch: async () => { throw new Error('offline'); } } };
  assert.equal((await policy.getAllowlistEligibility({ allowlist: { blockedRoleIds: ['blocked'] } }, guild, 'user')).allowed, false);
});
function builder() { return new Proxy({}, { get: () => () => builder() }); }
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, require: (name) => {
      if (name in mocks) return mocks[name];
      throw new Error(`Unexpected import ${name}`);
    }
  });
  return module.exports;
}

test('changing saved username queues review without identity or allowlist writes', async () => {
  let request;
  const command = load('Discord/commands/community/setMinecraftUsername.js', {
    'discord.js': { SlashCommandBuilder: builder },
    '../../allowlistPolicy': policy,
    '../../config': { channels: { usernameChangeReview: 'review' } },
    '../../usernameChangeReview': { sendUsernameChangeReview: async (...args) => { request = args; return { message: 'queued' }; } },
    '../interactionResponses': { safeReply: async () => {} }
  });
  await command.execute({ user: { id: 'user' }, client: {}, options: { getString: () => 'New' }, deferReply: async () => {} }, {
    backend: {
      getPlayerByDiscordUserId: async () => ({ player: { minecraftUsername: 'Old' } }),
      getPlayerByMinecraftUsername: async () => { throw { statusCode: 404 }; },
      setMinecraftUsername: () => assert.fail('must await approval')
    }, getAutoAllowlistServers: () => assert.fail('must await approval')
  });
  assert.equal(request[1], 'review');
  assert.equal(request[2].oldUsername, 'Old');
});

function reviewHarness({ approve = true, old = 'Old', eligible = true, staff = true, saveFails = false } = {}) {
  let handler;
  const writes = [];
  const replies = [];
  const server = { key: 's', allowlist: { autoAllowlist: false } };
  const client = { user: { id: 'bot' }, on: (_, callback) => { handler = callback; }, users: { fetch: async () => ({ send: async () => {} }) } };
  const review = load('Discord/usernameChangeReview.js', {
    'discord.js': {}, './log': { error: () => {} },
    './commands/interactionResponses': { safeReply: async (_, reply) => replies.push(reply.content) },
    './config': { channels: { usernameChangeReview: 'review' } },
    './minecraftServers': { listMinecraftServers: () => [server] },
    './allowlistPolicy': { ...policy, getAllowlistEligibility: async () => ({ allowed: eligible }) }
  });
  const backend = {
    getPlayerByDiscordUserId: async () => ({ player: { id: 1, minecraftUsername: old } }),
    getPlayerByMinecraftUsername: async () => { throw { statusCode: 404 }; },
    getPlayerProfile: async () => ({ servers: [{ serverKey: 's', available: true, profile: { allowlist: { permitted: true, ignoresPlayerLimit: true } } }] }),
    removePlayerFromServerAllowlist: async () => writes.push('remove'),
    setMinecraftUsername: async () => { writes.push('save'); if (saveFails) throw new Error('save failed'); return { player: { id: 1 } }; },
    addPlayerToServerAllowlist: async (_, payload) => { assert.equal(payload.ignoresPlayerLimit, true); writes.push('add'); }
  };
  review.registerUsernameChangeReview(client, { backend, ensureRole: async () => staff, roleIds: { STAFF: 'staff' } });
  const interaction = { isButton: () => true, customId: `mcname-${approve ? 'approve' : 'deny'}:user:New`, channelId: 'review', client, user: { id: 'reviewer' }, deferReply: async () => {}, message: { id: 'message', author: { id: 'bot' }, embeds: [{ fields: [{ name: 'Old username', value: 'Old' }] }], edit: async () => {} } };
  return { run: () => handler(interaction), writes, replies };
}
test('staff approval refreshes existing access and preserves player limit exemption', async () => {
  const harness = reviewHarness(); await harness.run();
  assert.deepEqual(harness.writes, ['remove', 'save', 'add']);
});
test('denial, stale requests and unauthorized reviewers do not write', async () => {
  for (const options of [{ approve: false }, { old: 'Different' }, { staff: false }]) {
    const harness = reviewHarness(options); await harness.run(); assert.deepEqual(harness.writes, []);
  }
});
test('blocked player is not re-allowlisted after username approval', async () => {
  const harness = reviewHarness({ eligible: false }); await harness.run();
  assert.deepEqual(harness.writes, ['remove', 'save']);
});

test('failed identity update restores the old allowlist', async () => {
  const harness = reviewHarness({ saveFails: true }); await harness.run();
  assert.deepEqual(harness.writes, ['remove', 'save', 'add']);
  assert.ok(harness.replies.some((reply) => reply.includes('save failed')));
});
