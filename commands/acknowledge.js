const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getIssueByShortId, updateStatus } = require('../lib/issues');
const { notifyUser } = require('../lib/notify');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('acknowledge')
    .setDescription('Mark an issue as acknowledged (team only)')
    .addStringOption(opt =>
      opt.setName('issue_id')
        .setDescription('Issue ID e.g. ISS-1001')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const shortId = interaction.options.getString('issue_id').toUpperCase();
    const issue   = await getIssueByShortId(shortId);

    if (!issue) {
      return interaction.editReply({ content: `No issue found with ID **${shortId}**.` });
    }

    if (issue.status !== 'open') {
      return interaction.editReply({
        content: `**${shortId}** is already ${issue.status} — no need to acknowledge again.`
      });
    }

    await updateStatus({
      issueId:   issue.id,
      newStatus: 'acknowledged',
      changedBy: interaction.user.id,
      note:      'Issue acknowledged by team'
    });

    await notifyUser(
      interaction.client,
      issue,
      'acknowledged',
      'A team member has seen your issue and will look into it.'
    );

    await interaction.editReply({
      content: `**${shortId}** marked as acknowledged. User has been notified via thread and DM.`
    });
  }
};
