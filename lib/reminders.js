const { getStaleIssues, markReminded } = require('./issues');
const { pingRoleInThread } = require('./forward');

async function runReminderJob(client) {
  console.log('[reminders] Checking for stale issues...');

  const staleIssues = await getStaleIssues();

  if (staleIssues.length === 0) {
    console.log('[reminders] No stale issues found');
    return;
  }

  console.log(`[reminders] Found ${staleIssues.length} stale issue(s)`);

  for (const issue of staleIssues) {
    if (!issue.thread_id) {
      console.warn(`[reminders] ${issue.short_id} has no thread_id — skipping`);
      continue;
    }

    let thread;
    try {
      thread = await client.channels.fetch(issue.thread_id);
    } catch (err) {
      console.error(`[reminders] ${issue.short_id} — could not fetch thread ${issue.thread_id}:`, err.message);
      continue;
    }

    if (!thread) {
      console.warn(`[reminders] ${issue.short_id} — thread returned null, skipping`);
      continue;
    }

    // Post reminder message in thread
    try {
      await thread.send({
        content: [
          `**Reminder — ${issue.short_id} has had no update in 48 hours.**`,
          ``,
          `This issue is still **${issue.status}** and the user is waiting.`,
          `Use \`/acknowledge ${issue.short_id}\` or \`/resolve ${issue.short_id}\` to update it.`
        ].join('\n')
      });
    } catch (err) {
      console.error(`[reminders] ${issue.short_id} — failed to post reminder:`, err.message);
      continue;
    }

    // Ping the relevant role inside the thread
    await pingRoleInThread(client, thread, issue, 'new_issue');

    // Mark as reminded — does NOT update updated_at so stale timer stays accurate
    await markReminded(issue.id);

    console.log(`[reminders] ${issue.short_id} reminded (count: ${(issue.reminder_count || 0) + 1})`);

    // Delay between issues to avoid Discord rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('[reminders] Job complete');
}

module.exports = { runReminderJob };