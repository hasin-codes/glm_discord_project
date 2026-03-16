const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getIssueByShortId, updateStatus } = require('../lib/issues');
const { notifyUser } = require('../lib/notify');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resolve')
    .setDescription('Mark an issue as resolved (team only)')
    .addStringOption(opt =>
      opt.setName('issue_id')
        .setDescription('Issue ID e.g. ISS-1001')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('note')
        .setDescription('Resolution note to share with the user')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const shortId = interaction.options.getString('issue_id').toUpperCase();
    const note    = interaction.options.getString('note') || 'Your issue has been resolved.';
    const issue   = await getIssueByShortId(shortId);

    if (!issue) {
      return interaction.editReply({ content: `No issue found with ID **${shortId}**.` });
    }

    if (issue.status === 'resolved' || issue.status === 'closed') {
      return interaction.editReply({
        content: `**${shortId}** is already ${issue.status}.`
      });
    }

    const success = await updateStatus({
      issueId:   issue.id,
      newStatus: 'resolved',
      changedBy: interaction.user.id,
      note
    });

    if (!success) {
      return interaction.editReply({ content: `Failed to update status. Try again.` });
    }

    await notifyUser(interaction.client, issue, 'resolved', note);

    await interaction.editReply({
      content: `**${shortId}** marked as resolved. User has been notified via thread and DM.`
    });
  }
};
