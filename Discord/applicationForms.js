const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const Log = require('./log');

const START_ID = 'application-start';

const drafts = new Map();
const submitting = new Set();

function buildForm(questions, responses, part) {
  const start = part * 5 + 1;
  const end = Math.min(part * 5 + 5, questions.length);
  const modal = new ModalBuilder().setCustomId(`application-form:${part}`).setTitle(`Application — Questions ${start}–${end}`);
  for (const [offset, question] of questions.slice(part * 5, part * 5 + 5).entries()) {
    const index = part * 5 + offset;
    const description = question.formDescription || question.prompt;
    const input = new TextInputBuilder().setCustomId(question.id).setStyle(TextInputStyle.Paragraph)
      .setRequired(Boolean(question.required)).setMaxLength(4000);
    if (responses.get(question.id)) input.setValue(responses.get(question.id).slice(0, 4000));
    modal.addLabelComponents(new LabelBuilder().setLabel(`${index + 1}. ${question.formLabel || question.label}`)
      .setDescription(description.slice(0, 100)).setTextInputComponent(input));
  }
  return modal;
}

function buildReview(questions, responses, reviewIndex = null) {
  const answered = questions.filter(q => (responses.get(q.id) || '').trim()).length;
  const groups = Array.from({ length: Math.ceil(questions.length / 5) }, (_, part) =>
    new ButtonBuilder().setCustomId(`application-part:${part}`)
      .setLabel(`Questions ${part * 5 + 1}–${Math.min(part * 5 + 5, questions.length)}`)
      .setStyle(ButtonStyle.Primary));
  const row = new ActionRowBuilder().addComponents(
    ...groups,
    new ButtonBuilder().setCustomId('application-review:0').setLabel('Review Answers').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('application-form-submit').setLabel('Submit for Approval').setStyle(ButtonStyle.Success)
      .setDisabled(questions.some(q => q.required && !(responses.get(q.id) || '').trim()))
  );
  const payload = { content: `**Your application — ${answered}/${questions.length} answered**\nComplete the question groups, then review your answers and submit. Your progress is saved.`, components: [row], embeds: [], allowedMentions: { parse: [] } };
  if (reviewIndex !== null) {
    payload.content += '\n\nLong answers are shortened here. Use the question buttons to see or change the full answers.';
    payload.embeds = buildAnswerEmbeds(questions, responses);
  }
  return payload;
}

function buildAnswerEmbeds(questions, responses) {
  return questions.map((question, index) => {
    const answer = responses.get(question.id) || '*Not answered yet*';
    return { title: `${index + 1}. ${question.formLabel || question.label}`, description: `${question.prompt}\n\n${answer.length > 500 ? `${answer.slice(0, 499)}â€¦` : answer}`, color: 0x5865f2 };
  });
}

async function showReview(interaction, questions, responses) {
  await interaction.editReply(buildReview(questions, responses));
}

function registerApplicationForms(client, config, helpers) {
  if (!config.questions.length || config.questions.length > 10) throw new Error('Application forms support 1 to 10 configured questions.');
  client.once('clientReady', async () => {
    try {
      const channel = await client.channels.fetch(config.applyHereChannelId);
      if (!channel?.isTextBased()) throw new Error('Apply-here channel is not text based.');
      const payload = { content: config.applicationIntro || '**Apply to join**\nUse the button below to start or resume your private application.',
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(START_ID).setLabel('Apply / Resume Application').setStyle(ButtonStyle.Primary))], allowedMentions: { parse: [] } };
      const messages = await channel.messages.fetch({ limit: 100 });
      const existing = messages.find(m => m.author.id === client.user.id && m.components.some(r => r.components.some(c => c.customId === START_ID)));
      if (existing) await existing.edit(payload);
      else await channel.send(payload);
      Log.info('Application Flow', 'Apply-here button ready.');
    } catch (err) { Log.error('Application Flow', 'Failed to publish apply-here button:', err); }
  });

  return async interaction => {
    const id = interaction.customId || '';
    if (![START_ID, 'application-form-submit'].includes(id) && !id.startsWith('application-part:') && !id.startsWith('application-form:') && !id.startsWith('application-review:')) return false;
    if (!interaction.guildId) { await interaction.reply({ content: 'Use the application button in the server.', ephemeral: true }); return true; }
    const userId = interaction.user.id;
    if (id.startsWith('application-part:')) {
      const part = Number(id.split(':')[1]);
      if (!Number.isInteger(part) || part < 0 || part >= Math.ceil(config.questions.length / 5)) throw new Error('Invalid application part.');
      const draft = drafts.get(userId);
      if (!draft) { await interaction.reply({ content: 'Click Apply / Resume Application again to reload your saved progress.', ephemeral: true }); return true; }
      await interaction.showModal(buildForm(config.questions, draft, part));
      return true;
    }
    // Buttons and modal submissions update the existing private panel.
    if (id !== START_ID && interaction.message) await interaction.deferUpdate();
    else await interaction.deferReply({ ephemeral: true });
    const current = await helpers.getApplication(userId);
    if (['submitted', 'accepted'].includes(current?.application?.status)) {
      await interaction.editReply({ content: current.application.status === 'submitted' ? 'Your application is already submitted for staff review.' : 'Your application has already been accepted.', components: [] });
      return true;
    }
    if (id.startsWith('application-form:')) {
      const part = Number(id.split(':')[1]);
      if (!Number.isInteger(part) || part < 0 || part >= Math.ceil(config.questions.length / 5)) throw new Error('Invalid application part.');
      for (const question of config.questions.slice(part * 5, part * 5 + 5)) {
        const response = interaction.fields.getTextInputValue(question.id).trim();
        if (question.required && !response) throw new Error('Required answers cannot be blank.');
        await helpers.saveApplicationResponse(userId, question.id, response);
      }
    }
    const responses = new Map((await helpers.getApplicationResponses(userId)).map(r => [r.question_id || r.questionId, r.response]));
    drafts.set(userId, responses);
    if (id.startsWith('application-review:')) {
      const index = Number(id.split(':')[1]);
      if (!Number.isInteger(index) || index < 0 || index >= config.questions.length) throw new Error('Invalid review question.');
      await interaction.editReply(buildReview(config.questions, responses, index));
      return true;
    }
    if (id !== 'application-form-submit') { await showReview(interaction, config.questions, responses); return true; }
    if (config.questions.some(q => q.required && !(responses.get(q.id) || '').trim())) {
      await interaction.editReply({ content: 'Complete all required questions before submitting.' }); return true;
    }
    if (submitting.has(userId)) { await interaction.editReply({ content: 'Your submission is already being processed.' }); return true; }
    submitting.add(userId);
    let reviewMessage;
    try {
      // Recheck after taking the lock: concurrent button clicks must not duplicate reviews.
      if ((await helpers.getApplication(userId))?.application?.status === 'submitted') {
        await interaction.editReply({ content: 'Your application is already submitted for staff review.' }); return true;
      }
      const channel = await client.channels.fetch(config.applicationsChannelId);
      if (!channel?.isTextBased()) throw new Error('Staff review channel is unavailable.');
      const embeds = buildAnswerEmbeds(config.questions, responses);
      reviewMessage = await channel.send({ content: `New application from <@${userId}>`, embeds,
        allowedMentions: { parse: [] }, components: [] });
      await helpers.setApplicationStatus(userId, 'submitted');
      await reviewMessage.edit({ components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`application-approve-${userId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`application-deny-${userId}`).setLabel('Deny / Request Changes').setStyle(ButtonStyle.Danger))] });
      await interaction.editReply({ content: 'Your application has been submitted for staff review.', components: [] });
    } catch (err) {
      if (reviewMessage) Log.error('Application Flow', `Submission needs attention: review message ${reviewMessage.id} for ${userId}`, err);
      throw err;
    } finally { submitting.delete(userId); }
    return true;
  };
}

function clearApplicationDraft(userId) {
  drafts.delete(userId);
}

module.exports = { registerApplicationForms, buildForm, buildReview, clearApplicationDraft };
