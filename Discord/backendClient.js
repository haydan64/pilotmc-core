const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3000';

function getBackendConfig() {
  return {
    baseUrl: process.env.BACKEND_URL || DEFAULT_BACKEND_URL,
    apiToken: process.env.BACKEND_API_TOKEN || ''
  };
}

async function requestBackend(path, options = {}) {
  const { baseUrl, apiToken } = getBackendConfig();
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const headers = {
    'Content-Type': 'application/json',
    ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(body?.error || body?.message || `Backend returned HTTP ${response.status}`);
    error.statusCode = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function getPlayerByDiscordUserId(discordUserId) {
  return requestBackend(`/api/players/discord/${encodeURIComponent(discordUserId)}`);
}

async function getPlayerProfile(discordUserId) {
  return requestBackend(`/api/players/discord/${encodeURIComponent(discordUserId)}/profile`);
}

async function getApplication(discordUserId) {
  return requestBackend(`/api/applications/discord/${encodeURIComponent(discordUserId)}`);
}

function normalizeApplicationResponse(row) {
  if (!row) return null;
  return {
    question_id: row.questionId || row.question_id,
    response: row.response,
    created_at: row.createdAt || row.created_at,
    updated_at: row.updatedAt || row.updated_at
  };
}

async function getApplicationResponses(discordUserId) {
  const result = await getApplication(discordUserId);
  return (result.responses || []).map(normalizeApplicationResponse);
}

async function getApplicationResponse(discordUserId, questionId) {
  return requestBackend(
    `/api/applications/discord/${encodeURIComponent(discordUserId)}/responses/${encodeURIComponent(questionId)}`
  ).then((result) => normalizeApplicationResponse(result.response)).catch((err) => {
    if (err.statusCode === 404) return null;
    throw err;
  });
}

async function saveApplicationResponse(discordUserId, questionId, response, actorDiscordUserId = discordUserId) {
  return requestBackend(
    `/api/applications/discord/${encodeURIComponent(discordUserId)}/responses/${encodeURIComponent(questionId)}`,
    {
      method: 'PUT',
      headers: {
        'x-actor-type': 'discord_user',
        ...(actorDiscordUserId ? { 'x-actor-id': actorDiscordUserId } : {})
      },
      body: JSON.stringify({ response })
    }
  ).then((result) => normalizeApplicationResponse(result.response));
}

async function deleteApplicationResponse(discordUserId, questionId, actorDiscordUserId = discordUserId) {
  return requestBackend(
    `/api/applications/discord/${encodeURIComponent(discordUserId)}/responses/${encodeURIComponent(questionId)}`,
    {
      method: 'DELETE',
      headers: {
        'x-actor-type': 'discord_user',
        ...(actorDiscordUserId ? { 'x-actor-id': actorDiscordUserId } : {})
      }
    }
  ).then((result) => normalizeApplicationResponse(result.response));
}

async function setApplicationStatus(discordUserId, status, reviewerDiscordUserId = null, denialReason = null) {
  return requestBackend(`/api/applications/discord/${encodeURIComponent(discordUserId)}/status`, {
    method: 'PUT',
    headers: {
      'x-actor-type': 'discord_user',
      ...(reviewerDiscordUserId ? { 'x-actor-id': reviewerDiscordUserId } : { 'x-actor-id': discordUserId })
    },
    body: JSON.stringify({ status, reviewerDiscordUserId, denialReason })
  }).then((result) => result.application);
}

async function resetApplication(discordUserId, actorDiscordUserId) {
  return requestBackend(`/api/applications/discord/${encodeURIComponent(discordUserId)}/reset`, {
    method: 'POST',
    headers: {
      'x-actor-type': 'discord_user',
      ...(actorDiscordUserId ? { 'x-actor-id': actorDiscordUserId } : {})
    },
    body: JSON.stringify({})
  });
}

async function getPlayerByMinecraftUsername(minecraftUsername) {
  return requestBackend(`/api/players/minecraft/${encodeURIComponent(minecraftUsername)}`);
}

async function setMinecraftUsername(discordUserId, minecraftUsername, actorDiscordUserId = discordUserId) {
  return requestBackend(`/api/players/discord/${encodeURIComponent(discordUserId)}/minecraft-username`, {
    method: 'PUT',
    headers: {
      'x-actor-type': 'discord_user',
      'x-actor-id': actorDiscordUserId
    },
    body: JSON.stringify({ minecraftUsername })
  });
}

async function removeMinecraftUsername(discordUserId, actorDiscordUserId) {
  return requestBackend(`/api/players/discord/${encodeURIComponent(discordUserId)}/minecraft-username`, {
    method: 'DELETE',
    headers: {
      'x-actor-type': 'discord_user',
      ...(actorDiscordUserId ? { 'x-actor-id': actorDiscordUserId } : {})
    }
  });
}

async function addPlayerToServerAllowlist(
  serverKey,
  { discordUserId, playerId, permitted = true, ignoresPlayerLimit = false, actorDiscordUserId = discordUserId }
) {
  return requestBackend(`/api/servers/${encodeURIComponent(serverKey)}/allowlist`, {
    method: 'POST',
    headers: {
      'x-actor-type': 'discord_user',
      ...(actorDiscordUserId ? { 'x-actor-id': actorDiscordUserId } : {})
    },
    body: JSON.stringify({
      discordUserId,
      playerId,
      permitted,
      ignoresPlayerLimit
    })
  });
}

async function removePlayerFromServerAllowlist(serverKey, playerId, actorDiscordUserId) {
  return requestBackend(
    `/api/servers/${encodeURIComponent(serverKey)}/allowlist/${encodeURIComponent(playerId)}`,
    {
      method: 'DELETE',
      headers: {
        'x-actor-type': 'discord_user',
        ...(actorDiscordUserId ? { 'x-actor-id': actorDiscordUserId } : {})
      }
    }
  );
}

async function sendServerCommand(serverKey, payload, actorDiscordUserId) {
  return requestBackend(`/api/servers/${encodeURIComponent(serverKey)}/commands`, {
    method: 'POST',
    headers: {
      'x-actor-type': 'discord_user',
      ...(actorDiscordUserId ? { 'x-actor-id': actorDiscordUserId } : {})
    },
    body: JSON.stringify(payload)
  });
}

module.exports = {
  getPlayerByDiscordUserId,
  getPlayerProfile,
  getApplication,
  getApplicationResponses,
  getApplicationResponse,
  saveApplicationResponse,
  deleteApplicationResponse,
  setApplicationStatus,
  resetApplication,
  getPlayerByMinecraftUsername,
  setMinecraftUsername,
  removeMinecraftUsername,
  addPlayerToServerAllowlist,
  removePlayerFromServerAllowlist,
  sendServerCommand
};
