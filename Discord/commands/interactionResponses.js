const Log = require('../log');

function isRecoverableInteractionError(err) {
  return err?.code === 10062 || err?.code === 40060;
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      const { ephemeral, ...editPayload } = payload || {};
      return await interaction.editReply(editPayload);
    }
    return await interaction.reply(payload);
  } catch (err) {
    if (isRecoverableInteractionError(err)) {
      Log.warn(
        'Interaction Responses',
        `Ignored expired or already-acknowledged interaction ${interaction.customId || interaction.commandName || 'unknown'}: ${err.message}`
      );
      return null;
    }
    Log.error('Interaction Responses', `Failed to respond to interaction ${interaction.commandName || 'unknown'}:`, err.message);
    return null;
  }
}

async function safeShowModal(interaction, modal) {
  try {
    return await interaction.showModal(modal);
  } catch (err) {
    if (isRecoverableInteractionError(err)) {
      Log.warn(
        'Interaction Responses',
        `Ignored expired interaction while showing modal ${interaction.customId || interaction.commandName || 'unknown'}: ${err.message}`
      );
      return null;
    }
    throw err;
  }
}

async function replyWithRequestResult(interaction, requestPromise, options = {}) {
  const ephemeral = options.ephemeral !== false;

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral });
  }

  try {
    const result = await requestPromise;
    return safeReply(interaction, {
      content: result?.message || options.successMessage || 'Done.'
    });
  } catch (err) {
    Log.error('Interaction Responses', `Request-backed command failed for ${interaction.commandName || 'unknown'}:`, err);
    return safeReply(interaction, {
      content: options.errorMessage || `There was an error completing that request: ${err.message}`
    });
  }
}

module.exports = {
  replyWithRequestResult,
  safeReply,
  safeShowModal,
  isRecoverableInteractionError
};
