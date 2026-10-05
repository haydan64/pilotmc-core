const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');
const Log = require('./log');
const { safeReply, safeShowModal, isRecoverableInteractionError } = require('./commands/interactionResponses');

const { registerApplicationForms } = require('./applicationForms');

const RESPONSE_ACTION_PREFIX = 'app-resp';

function truncateLabel(label, max = 45) {
  const safeLabel = label || '';
  return safeLabel.length > max ? `${safeLabel.slice(0, Math.max(0, max - 3))}...` : safeLabel;
}

function buildResponseActionCustomId(questionId, sourceChannelId, sourceMessageId) {
  const customId = `${RESPONSE_ACTION_PREFIX}:${questionId}:${sourceChannelId || 'none'}:${sourceMessageId || 'none'}`;
  if (customId.length > 100) {
    return `${RESPONSE_ACTION_PREFIX}:${questionId}:${(sourceChannelId || 'none').slice(-10)}:${(sourceMessageId || 'none').slice(-10)}`;
  }
  return customId;
}

function findSubmitLabelFromMessage(message) {
  return message?.components
    ?.flatMap((row) => row.components || [])
    .find((component) => component.customId === 'application-submit')?.label;
}

function buildQuestionSelect(questions, responsesMap = new Map(), customId = 'application-question-select') {
  const options = questions.map((question) => {
    const answered = Boolean((responsesMap.get(question.id) || '').trim());
    const indicator = answered ? '✅' : '⬜';
    return {
      label: truncateLabel(`${indicator} ${question.label || question.prompt || 'Question'}`),
      description: truncateLabel(question.prompt || '', 100),
      value: question.id
    };
  });

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Select a question to answer or edit')
      .addOptions(options)
  );
}

function formatResponses(responsesMap, questions) {
  if (!questions?.length) return 'No questions configured.';
  return questions
    .map((question, index) => {
      const answer = responsesMap.get(question.id);
      const label = question.label || question.prompt || 'Question';
      const questionTitle = question.prompt && question.label ? `${question.label} - ${question.prompt}` : label;
      const indicator = (answer || '').trim() ? '✅' : '⬜';
      return `**${index + 1}. ${questionTitle}**${indicator} ${answer || '*No response yet*'}`;
    })
    .join('\n\n');
}

function hasAllRequiredResponses(responsesMap, questions) {
  return questions.every((question) => !question.required || (responsesMap.get(question.id) || '').trim().length);
}

function buildProgressEmbed(responsesMap, questions, title = 'Application Progress') {
  const description = truncateLabel(formatResponses(responsesMap, questions), 4096);
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(0x5865f2);
}

async function sendWaitingRoomPrompt(channel, user, questions, responsesMap = new Map(), submitLabel = 'Submit for Approval') {
  if (!channel || !channel.isTextBased()) return null;
  const content = `<@${user.id}> Welcome! Please start your application by selecting a question below.`;
  const embed = buildProgressEmbed(responsesMap, questions);
  const components = buildActionRows(responsesMap, questions, submitLabel);
  return channel.send({ content, embeds: [embed], components, allowedMentions: { users: [user.id] } });
}

async function sendApplicationDm(user, questions, responsesMap = new Map(), submitLabel = 'Submit for Approval') {
  if (!user?.createDM) return null;
  try {
    const dmChannel = await user.createDM();
    const embed = buildProgressEmbed(responsesMap, questions);
    const components = buildActionRows(responsesMap, questions, submitLabel);
    const content = 'Welcome! Please complete your application using the menu below.';
    return await dmChannel.send({ content, embeds: [embed], components });
  } catch (err) {
    Log.error('Application Flow', `Failed to send DM to ${user?.id}:`, err.message);
    return null;
  }
}

async function sendInitialApplicationMessage(user, questions, guild, waitingRoomChannelId) {
  const responsesMap = new Map();
  const dmMessage = await sendApplicationDm(user, questions, responsesMap);
  if (dmMessage) return { location: 'dm', message: dmMessage };

  if (waitingRoomChannelId && guild) {
    const channel = guild.channels.cache.get(waitingRoomChannelId) || (await guild.channels.fetch(waitingRoomChannelId).catch(() => null));
    const fallbackMessage = await sendWaitingRoomPrompt(channel, user, questions, responsesMap);
    if (fallbackMessage) return { location: 'waiting-room', message: fallbackMessage };
  }

  return null;
}

function buildActionRows(responsesMap, questions, submitLabel = 'Submit for Approval') {
  const submitButton = new ButtonBuilder()
    .setCustomId('application-submit')
    .setLabel(submitLabel)
    .setStyle(ButtonStyle.Success)
    .setDisabled(!hasAllRequiredResponses(responsesMap, questions));

  const rows = [buildQuestionSelect(questions, responsesMap)];
  rows.push(new ActionRowBuilder().addComponents(submitButton));
  return rows;
}

async function sendResponseSummary(interaction, responsesMap, questions, options = {}) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);
  }

  await interaction.deleteReply().catch(() => null);
}

async function handleQuestionSelect(interaction, questions, getApplicationResponse) {
  const questionId = interaction.values?.[0];
  const question = questions.find((q) => q.id === questionId);
  if (!question) {
    await interaction.reply({ content: 'That question is no longer available.', ephemeral: true });
    return;
  }

  const existingResponse = await getApplicationResponse(interaction.user.id, question.id);
  const submitLabelFromMessage = interaction.message?.components
    ?.flatMap((row) => row.components || [])
    .find((component) => component.customId === 'application-submit')?.label;

  if (existingResponse?.response) {
    const actionSelect = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(
          buildResponseActionCustomId(question.id, interaction.message?.channelId, interaction.message?.id)
        )
        .setPlaceholder('Edit or delete your answer')
        .addOptions(
          { label: 'Edit answer', value: 'edit', description: 'Update your existing response' },
          { label: 'Delete answer', value: 'delete', description: 'Remove your current response' }
        )
    );

    await interaction.reply({ content: 'What would you like to do with this answer?', components: [actionSelect], ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`application-modal-${question.id}:${interaction.message?.channelId || 'none'}:${interaction.message?.id || 'none'}`)
    .setTitle(truncateLabel(question.label || 'Application Question'));

  const responseInput = new TextInputBuilder()
    .setCustomId('response')
    .setLabel(truncateLabel(question.prompt || 'Your answer'))
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(truncateLabel(question.prompt || 'Please share your answer.', 100))
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(responseInput));
  await safeShowModal(interaction, modal);
}

async function handleModalSubmit(
  interaction,
  questions,
  saveApplicationResponse,
  getApplicationResponses
) {
  const [questionId, sourceChannelId, sourceMessageId] = interaction.customId.replace('application-modal-', '').split(':');
  const question = questions.find((q) => q.id === questionId);
  if (!question) {
    await interaction.reply({ content: 'That question is no longer available.', ephemeral: true });
    return;
  }

  const response = (interaction.fields.getTextInputValue('response') || '').trim();

  if (!response.length) {
    const message = question.required
      ? 'Please provide a response. Use the delete option from the action menu if you want to clear an existing answer.'
      : 'Please provide a response, or choose the delete option from the action menu to remove your answer.';
    await interaction.reply({ content: message, ephemeral: true });
    return;
  }

  await saveApplicationResponse(interaction.user.id, question.id, response);
  const responses = await getApplicationResponses(interaction.user.id);
  const responsesMap = buildResponseMap(responses);
  if (sourceChannelId && sourceChannelId !== 'none' && sourceMessageId && sourceMessageId !== 'none') {
    await refreshApplicationMessage(interaction.client, sourceChannelId, sourceMessageId, interaction.user.id, responsesMap, questions);
  }
  await sendResponseSummary(interaction, responsesMap, questions);
}

async function handleSubmit(interaction, questions, getApplication, getApplicationResponses, setApplicationStatus, sendToChannel, applicationsChannelId) {
  const current = await getApplication(interaction.user.id).catch(() => null);
  const currentStatus = current?.application?.status || 'draft';
  if (currentStatus === 'submitted') {
    await interaction.reply({ content: 'Your application is already submitted for review.', ephemeral: true });
    return null;
  }
  if (currentStatus === 'accepted') {
    await interaction.reply({ content: 'Your application has already been accepted.', ephemeral: true });
    return null;
  }

  const responses = await getApplicationResponses(interaction.user.id);
  const responsesMap = buildResponseMap(responses);
  if (!hasAllRequiredResponses(responsesMap, questions)) {
    await interaction.reply({ content: 'Please answer all required questions before submitting.', ephemeral: true });
    return;
  }

  const application = await setApplicationStatus(interaction.user.id, 'submitted');
  const fields = questions.map((question, index) => ({
    name: `${index + 1}. ${truncateLabel(question.prompt)}`,
    value: truncateLabel(responsesMap.get(question.id) || '*No response*', 500)
  }));

  const embed = new EmbedBuilder()
    .setTitle('New Player Application')
    .setDescription(`Applicant: <@${interaction.user.id}>`)
    .setColor(0x43b581)
    .addFields(fields)
    .setTimestamp();

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`application-approve-${interaction.user.id}`)
        .setLabel('Accept')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`application-deny-${interaction.user.id}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
    )
  ];

  await sendToChannel(interaction.client, applicationsChannelId, { embeds: [embed], components });
  await interaction.message?.edit({ components: [] }).catch(() => null);
  await interaction.reply({ content: 'Your application has been submitted for review.', ephemeral: true });
  return application;
}

function buildResponseMap(responses) {
  return new Map(responses.map((row) => [row.question_id || row.questionId, row.response]));
}

async function refreshApplicationMessage(
  client,
  channelId,
  messageId,
  userId,
  responsesMap,
  questions,
  submitLabel
) {
  if (!channelId || !messageId) return;
  const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased()) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message || !message.editable) return;
  const resolvedSubmitLabel =
    submitLabel || findSubmitLabelFromMessage(message) || 'Submit for Approval';
  const embed = buildProgressEmbed(responsesMap, questions);
  const components = buildActionRows(responsesMap, questions, resolvedSubmitLabel);

  await message.edit({ content: message.content || `<@${userId}>`, embeds: [embed], components });
}

async function sendDeniedOverview(guild, waitingRoomChannelId, targetUserId, responsesMap, questions, reason) {
  // if (!waitingRoomChannelId || !guild) return;
  // const channel = guild.channels.cache.get(waitingRoomChannelId) || (await guild.channels.fetch(waitingRoomChannelId).catch(() => null));
  // if (!channel || !channel.isTextBased()) return;

  // const embed = buildProgressEmbed(responsesMap, questions, 'Application Denied');
  // embed.addFields({ name: 'Status', value: `Denied reason: ${reason || 'No reason provided.'}` });

  // const components = buildActionRows(responsesMap, questions, 'Resubmit Application');
  // await channel.send({
  //   content: `<@${targetUserId}> Your application was denied. You can edit your responses below and resubmit.`,
  //   embeds: [embed],
  //   components,
  //   allowedMentions: { users: [targetUserId] }
  // });
}

async function registerApplicationFlow(client, config, helpers) {
  const { waitingRoomChannelId, applicationsChannelId } = config;
  const {
    saveApplicationResponse,
    getApplicationResponses,
    getApplicationResponse,
    getApplication,
    deleteApplicationResponse,
    setApplicationStatus,
    sendToChannel,
    ensureRole,
    roleIds,
    rolesConfig
  } = helpers;
  const questions = config.questions || [];
  const handleForms = config.applyHereChannelId ? registerApplicationForms(client, config, helpers) : null;

  client.on('guildMemberAdd', async (member) => {
    if (member.user.bot || !questions.length || config.applyHereChannelId) return;
    try {
      const result = await sendInitialApplicationMessage(member.user, questions, member.guild, waitingRoomChannelId);
      if (result?.location) {
        Log.info('Application Flow', `Sent initial application prompt to ${member.id} via ${result.location}.`);
      } else {
        Log.warn('Application Flow', `Unable to deliver initial application prompt to ${member.id}.`);
      }
    } catch (err) {
      Log.error('Application Flow', `Failed to deliver initial application prompt to ${member.id}:`, err);
    }
  });
  client.on('interactionCreate', async (interaction) => {
    try {
    if (handleForms && await handleForms(interaction)) return;
    if (interaction.isStringSelectMenu() && interaction.customId === 'application-question-select') {
      await handleQuestionSelect(interaction, questions, getApplicationResponse);
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      (interaction.customId.startsWith(RESPONSE_ACTION_PREFIX) || interaction.customId.startsWith('application-response-action'))
    ) {
      const [, questionId, sourceChannelId, sourceMessageId, encodedLabel] = interaction.customId.split(':');
      const submitLabel = encodedLabel ? decodeURIComponent(encodedLabel) : undefined;
      const action = interaction.values?.[0];
      const question = questions.find((q) => q.id === questionId);

      if (!question) {
        await interaction.reply({ content: 'That question is no longer available.', ephemeral: true });
        return;
      }

      if (action === 'delete') {
        await deleteApplicationResponse(interaction.user.id, question.id);
        const responses = await getApplicationResponses(interaction.user.id);
        const responsesMap = buildResponseMap(responses);

        if (sourceChannelId && sourceChannelId !== 'none' && sourceMessageId && sourceMessageId !== 'none') {
          await refreshApplicationMessage(
            interaction.client,
            sourceChannelId,
            sourceMessageId,
            interaction.user.id,
            responsesMap,
            questions,
            submitLabel || undefined
          );
        }

        await sendResponseSummary(interaction, responsesMap, questions, { submitLabel });
        return;
      }

      const existingResponse = await getApplicationResponse(interaction.user.id, question.id);

      const modal = new ModalBuilder()
        .setCustomId(
          `application-modal-${question.id}:${sourceChannelId || 'none'}:${sourceMessageId || 'none'}`
        )
        .setTitle(truncateLabel(question.label || 'Application Question'));

      const responseInput = new TextInputBuilder()
        .setCustomId('response')
        .setLabel(truncateLabel(question.prompt || 'Your answer'))
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder(truncateLabel(question.prompt || 'Please share your answer.', 100))
        .setRequired(true);

      if (existingResponse?.response) {
        responseInput.setValue(existingResponse.response.slice(0, 4000));
      }

      modal.addComponents(new ActionRowBuilder().addComponents(responseInput));
      await safeShowModal(interaction, modal);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'application-delete-answer') {
      const responses = await getApplicationResponses(interaction.user.id);
      const responseMap = buildResponseMap(responses);
      const answeredQuestions = questions.filter((q) => (responseMap.get(q.id) || '').trim());
      if (!answeredQuestions.length) {
        await interaction.reply({ content: 'You have no answers to delete yet.', ephemeral: true });
        return;
      }

      const submitLabelFromMessage = interaction.message?.components
        ?.flatMap((row) => row.components || [])
        .find((component) => component.customId === 'application-submit')?.label;

      const selectRow = buildQuestionSelect(
        answeredQuestions,
        responseMap,
        `application-delete-select:${interaction.message?.channelId || 'none'}:${interaction.message?.id || 'none'}:${encodeURIComponent(
          submitLabelFromMessage || ''
        )}`
      );
      selectRow.components[0].setPlaceholder('Select a question to delete the answer');

      await interaction.reply({ content: 'Choose which answer you want to delete.', components: [selectRow], ephemeral: true });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('application-delete-select')) {
      const [, sourceChannelId, sourceMessageId, encodedLabel] = interaction.customId.split(':');
      const submitLabel = encodedLabel ? decodeURIComponent(encodedLabel) : undefined;
      const questionId = interaction.values?.[0];
      const question = questions.find((q) => q.id === questionId);
      if (!question) {
        await interaction.reply({ content: 'That question is no longer available.', ephemeral: true });
        return;
      }

      await deleteApplicationResponse(interaction.user.id, question.id);
      const responses = await getApplicationResponses(interaction.user.id);
      const responsesMap = buildResponseMap(responses);

      if (sourceChannelId && sourceChannelId !== 'none' && sourceMessageId && sourceMessageId !== 'none') {
        await refreshApplicationMessage(
          interaction.client,
          sourceChannelId,
          sourceMessageId,
          interaction.user.id,
          responsesMap,
          questions,
          submitLabel || undefined
        );
      }

      await sendResponseSummary(interaction, responsesMap, questions, { submitLabel });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('application-modal-')) {
      await handleModalSubmit(
        interaction,
        questions,
        saveApplicationResponse,
        getApplicationResponses
      );
      return;
    }

    if (interaction.isButton() && interaction.customId === 'application-submit') {
      await handleSubmit(
        interaction,
        questions,
        getApplication,
        getApplicationResponses,
        setApplicationStatus,
        sendToChannel,
        applicationsChannelId
      );
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('application-approve-')) {
      const targetUserId = interaction.customId.replace('application-approve-', '');
      const allowed = await ensureRole(
        interaction,
        [roleIds?.STAFF, roleIds?.ADMIN, roleIds?.DEVELOPER].filter(Boolean),
        'Only staff can review applications.'
      );
      if (!allowed) return;

      await setApplicationStatus(targetUserId, 'accepted', interaction.user.id);
      const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);

      if (member) {
        if (rolesConfig?.guest && member.roles.cache.has(rolesConfig.guest)) {
          await member.roles.remove(rolesConfig.guest).catch(() => null);
        }
        if (rolesConfig?.member) {
          await member.roles.add(rolesConfig.member).catch(() => null);
        }
      }

      await interaction.message?.edit({
        content: `Application for <@${targetUserId}>\n**Accepted by <@${interaction.user.id}>**`,
        components: [],
        allowedMentions: { parse: [] }
      });
      await interaction.reply({ content: `Application for <@${targetUserId}> has been accepted by <@${interaction.user.id}>.`, ephemeral: true });

      const notification = `Your application has been accepted! Welcome to the server.`;
      const waitingRoomChannel = waitingRoomChannelId
        ? interaction.guild.channels.cache.get(waitingRoomChannelId) ||
          (await interaction.guild.channels.fetch(waitingRoomChannelId).catch(() => null))
        : null;
      if (member) {
        await member.send(notification).catch(async () => {
          if (waitingRoomChannel) {
            await waitingRoomChannel.send({
              content: `<@${targetUserId}> ${notification}`,
              allowedMentions: { users: [targetUserId] }
            });
          }
        });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('application-deny-')) {
      const targetUserId = interaction.customId.replace('application-deny-', '');
      const allowed = await ensureRole(
        interaction,
        [roleIds?.STAFF, roleIds?.ADMIN, roleIds?.DEVELOPER].filter(Boolean),
        'Only staff can review applications.'
      );
      if (!allowed) return;

      const modal = new ModalBuilder()
        .setCustomId(`application-deny-modal-${targetUserId}:${interaction.channelId || 'none'}:${interaction.message?.id || 'none'}`)
        .setTitle('Deny Application');

      const reasonInput = new TextInputBuilder()
        .setCustomId('deny-reason')
        .setLabel('Reason for denial')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await safeShowModal(interaction, modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('application-deny-modal-')) {
      const [targetUserId, sourceChannelId, sourceMessageId] = interaction.customId.replace('application-deny-modal-', '').split(':');
      const allowed = await ensureRole(
        interaction,
        [roleIds?.STAFF, roleIds?.ADMIN, roleIds?.DEVELOPER].filter(Boolean),
        'Only staff can review applications.'
      );
      if (!allowed) return;

      const reason = interaction.fields.getTextInputValue('deny-reason');
      await setApplicationStatus(targetUserId, 'denied', interaction.user.id, reason);

      const responses = await getApplicationResponses(targetUserId);
      const responsesMap = buildResponseMap(responses);

      const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
      const notice = `**Your application was denied.** Reason: ${reason}${config.applyHereChannelId ? `\nEdit and resubmit using <#${config.applyHereChannelId}>.` : ''}`;
      const targetUser = member?.user || (await interaction.client.users.fetch(targetUserId).catch(() => null));
      if (targetUser) {
        await targetUser.send({ content: truncateLabel(notice, 2000), allowedMentions: { parse: [] } }).catch(() => null);
        if (!config.applyHereChannelId) await sendApplicationDm(targetUser, questions, responsesMap, 'Resubmit Application');
      }

      await sendDeniedOverview(interaction.guild, waitingRoomChannelId, targetUserId, responsesMap, questions, reason);
      if (sourceChannelId && sourceChannelId !== 'none' && sourceMessageId && sourceMessageId !== 'none') {
        const sourceChannel = interaction.client.channels.cache.get(sourceChannelId) ||
          (await interaction.client.channels.fetch(sourceChannelId).catch(() => null));
        const sourceMessage = sourceChannel?.isTextBased()
          ? await sourceChannel.messages.fetch(sourceMessageId).catch(() => null)
          : null;
        await sourceMessage?.edit({ components: [] }).catch(() => null);
      }

      await interaction.reply({ content: `<@${interaction?.user?.id || "error"}> Denied application for <@${targetUserId}>.` });
      return;
    }
    } catch (err) {
      if (isRecoverableInteractionError(err)) {
        Log.warn(
          'Application Flow',
          `Ignored expired or already-acknowledged interaction ${interaction.customId || interaction.commandName || 'unknown'}: ${err.message}`
        );
        return;
      }

      Log.error('Application Flow', `Error handling interaction ${interaction.customId || interaction.commandName || 'unknown'}:`, err);
      await safeReply(interaction, { content: 'There was an error handling that application action.', ephemeral: true });
    }
  });
}

module.exports = {
  registerApplicationFlow,
  buildQuestionSelect,
  formatResponses,
  hasAllRequiredResponses,
  buildResponseMap,
  sendInitialApplicationMessage,
  sendWaitingRoomPrompt
};
