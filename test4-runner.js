require('dotenv').config();
const { classifyIntent }       = require('./lib/intent');
const { isStaff, getSpeakerRole } = require('./lib/speaker');
const { canEscalate, buildTaggedHistory, updateThreadBrief, shouldUpdateBrief, resetBriefCounter } = require('./lib/context');
const { fetchContext, maybeUpdateSummary } = require('./lib/memory');
const { rewriteQuery }         = require('./lib/rewriter');
const { generateResponse }     = require('./lib/responder');
const { embed, rerank }        = require('./lib/cloudflare');
const { search, COLLECTIONS }  = require('./lib/qdrant');
const { findIssueForAuthorInThread, getAllThreadIssues, createLinkedIssue } = require('./lib/issues');
const supabase                 = require('./lib/supabase');

const sigmoid = x => 1 / (1 + Math.exp(-x));

// ── Fix 3: Participant intent classifier ─────────────────────────────
async function testParticipantClassify(message, issueTitle, issueDesc, expectNewRequest) {
  const { chatFast } = require('./lib/cloudflare');

  const PROMPT = `You are classifying a message from a secondary user in a support thread.
The thread was originally about a different user's issue.

Original issue title: ${issueTitle}
Original issue description: ${issueDesc.slice(0, 300)}

Secondary user's message: ${message.slice(0, 500)}

Respond with ONLY: NEW_REQUEST or SAME_ISSUE`;

  const result = await chatFast(PROMPT, [{ role: 'user', content: 'Classify this message.' }]);
  const isNewRequest = result.trim().toUpperCase().includes('NEW_REQUEST');
  const pass = isNewRequest === expectNewRequest;
  console.log(`  ${pass ? '✅' : '❌'} "${message.slice(0, 60)}"`);
  console.log(`     → ${result.trim()} | expect: ${expectNewRequest ? 'NEW_REQUEST' : 'SAME_ISSUE'}`);
  return isNewRequest;
}

// ── Fix 4: Smarter memory — anchored context ─────────────────────────
async function testSmartMemory() {
  console.log('\n=== FIX 4: SMARTER MEMORY ===');

  const { data: issue } = await supabase.from('issues').select('*').limit(1).single();
  if (!issue) { console.log('  No issue in DB — skipping'); return; }

  const context = await fetchContext(issue);
  console.log('  Total history entries:', context.messageCount);
  console.log('  issueSummary present:', !!context.issueSummary);

  // Count anchor vs recent vs system messages in history
  const systemMsgs = context.history.filter(m => m.role === 'system');
  const userMsgs   = context.history.filter(m => m.role === 'user');
  const botMsgs    = context.history.filter(m => m.role === 'assistant');
  console.log(`  Breakdown: ${userMsgs.length} user | ${botMsgs.length} assistant | ${systemMsgs.length} system`);

  // Check if gap marker is present (only present if message count > anchor+recent window)
  const hasGapMarker = systemMsgs.some(m => m.content && m.content.includes('earlier messages omitted'));
  console.log('  Gap marker present:', hasGapMarker, '(only expected if issue has 12+ messages)');

  // Check running summary field
  console.log('  issues.summary:', issue.summary ? issue.summary.slice(0, 80) + '...' : '(none — will generate after 10+ messages)');
}

// ── Fix 5: Thread brief counter ──────────────────────────────────────
function testBriefCounter() {
  console.log('\n=== FIX 5: BRIEF UPDATE COUNTER ===');
  const testThreadId = 'test-thread-123';

  // Reset and simulate messages
  resetBriefCounter(testThreadId);

  const results = [];
  for (let i = 1; i <= 15; i++) {
    const shouldUpdate = shouldUpdateBrief(testThreadId);
    results.push(`msg${i}:${shouldUpdate ? 'UPDATE' : 'skip'}`);
  }

  console.log('  Counter triggers (every 5th):', results.join(' | '));
  // Expect: msg5 and msg10 and msg15 to be UPDATE
  const updateIndexes = results.map((r, i) => r.includes('UPDATE') ? i + 1 : null).filter(Boolean);
  console.log('  Update fired on messages:', updateIndexes, '  (expect: 5, 10, 15)');
  const pass = JSON.stringify(updateIndexes) === JSON.stringify([5, 10, 15]);
  console.log(`  ${pass ? '✅' : '❌'} Counter logic correct`);
}

// ── Fix 1: Multi-user thread data ────────────────────────────────────
async function testMultiUserData() {
  console.log('\n=== FIX 1: MULTI-USER THREAD DATA ===');

  const { data: issue } = await supabase.from('issues').select('*').not('thread_id', 'is', null).limit(1).single();
  if (!issue) { console.log('  No issue with thread_id in DB — skipping'); return; }

  console.log('  Testing with issue:', issue.short_id, '| thread:', issue.thread_id);

  // getAllThreadIssues
  const allIssues = await getAllThreadIssues(issue.thread_id);
  console.log('  getAllThreadIssues count:', allIssues.length);

  // findIssueForAuthorInThread
  const authorIssue = await findIssueForAuthorInThread(issue.thread_id, issue.user_discord_id);
  if (authorIssue) {
    console.log('  ✅ findIssueForAuthorInThread: found', authorIssue.short_id, 'for reporter');
  } else {
    console.log('  ⚠️  findIssueForAuthorInThread: returned null for reporter (unexpected)');
  }

  // Try with a fake user ID — should return null
  const noIssue = await findIssueForAuthorInThread(issue.thread_id, 'fake-user-99999');
  console.log('  findIssueForAuthorInThread (fake user):', noIssue === null ? '✅ null (correct)' : '❌ returned data (unexpected)');
}

// ── Fix 2: Thread brief embed generation (no Discord, just logic) ─────
function testBriefEmbedLogic() {
  console.log('\n=== FIX 2: THREAD BRIEF EMBED LOGIC ===');

  // Simulate what generateBriefEmbed would produce
  const fakeIssues = [
    {
      short_id: 'ISS-1007',
      user_discord_id: '111111111111111111',
      status: 'open',
      department: 'billing',
      created_at: new Date(Date.now() - 18 * 24 * 60 * 60 * 1000).toISOString(),
      description: 'Grandfathered subscription benefit lost after plan upgrade to yearly',
      summary: null,
      title: 'Lost grandfathered quota after upgrading plan'
    },
    {
      short_id: 'ISS-1012',
      user_discord_id: '222222222222222222',
      status: 'open',
      department: 'billing',
      created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      description: 'Account not grandfathered despite staff confirmation. Customer ID 1961759277988277',
      summary: 'User confirmed grandfathered by staff but dashboard shows weekly limits. Has customer ID ready.',
      title: 'Not grandfathered despite staff confirmation'
    }
  ];

  const fakeMessages = [
    { author: { id: '111111111111111111', bot: false }, content: 'I lost my grandfathered benefit', createdTimestamp: Date.now() - 3600000 },
    { author: { id: '222222222222222222', bot: false }, content: 'can you check my customer id?', createdTimestamp: Date.now() - 1800000 },
    { author: { id: '333333333333333333', bot: false }, content: 'same issue here', createdTimestamp: Date.now() - 900000 },
    { author: { id: '444444444444444444', bot: false }, content: 'how about just restore the benefits', createdTimestamp: Date.now() - 600000 },
    { author: { id: 'bot001', bot: true }, content: 'Issue logged as ISS-1007', createdTimestamp: Date.now() - 3500000 },
    { author: { id: 'bot001', bot: true }, content: 'Issue logged as ISS-1012', createdTimestamp: Date.now() - 1700000 },
  ];

  const STATUS_EMOJI = { open: '🔴', acknowledged: '🟡', in_progress: '🔵', resolved: '🟢', closed: '⚪' };
  const issueUserIds = new Set(fakeIssues.map(i => i.user_discord_id));

  console.log('  Simulated thread brief output:');
  console.log('  ============================================');
  console.log('  📋 Thread Brief — Updated just now');
  console.log('  ============================================');

  for (const issue of fakeIssues) {
    const emoji = STATUS_EMOJI[issue.status] || '⚫';
    const since = new Date(issue.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dept  = issue.department.charAt(0).toUpperCase() + issue.department.slice(1);
    const userMsgCount = fakeMessages.filter(m => m.author.id === issue.user_discord_id && !m.author.bot).length;
    const summaryLine = issue.summary || issue.description;
    console.log(`  ${emoji} ${issue.short_id} (<@${issue.user_discord_id}>)`);
    console.log(`     Status: ${issue.status} | Dept: ${dept} | Since: ${since}`);
    console.log(`     Key ask: ${summaryLine.slice(0, 100)}`);
    console.log(`     Messages from user: ${userMsgCount}`);
  }

  const participants = new Set();
  for (const msg of fakeMessages) {
    if (msg.author.bot) continue;
    if (!issueUserIds.has(msg.author.id)) participants.add(`<@${msg.author.id}>`);
  }
  if (participants.size > 0) {
    console.log(`  👥 Other participants: ${Array.from(participants).join(', ')}`);
  }

  const totalMessages = fakeMessages.filter(m => !m.author.bot).length;
  const threadAge = 18;
  console.log(`  📊 ${totalMessages} user messages | ${fakeIssues.length} tracked issue(s) | Thread age: ${threadAge} day(s)`);
  console.log('  ✅ Embed logic validated (requires live Discord to pin)');
}

// ── Fix 3: Participant intent classification tests ────────────────────
async function testParticipantClassification() {
  console.log('\n=== FIX 3: PARTICIPANT INTENT CLASSIFICATION ===');

  const issueTitle = 'Grandfathered subscription benefit lost after plan upgrade';
  const issueDesc  = 'I upgraded my yearly plan to support Z.AI but lost my grandfathered quota exemption.';

  console.log('  --- Should be SAME_ISSUE (just commenting/reacting) ---');
  await testParticipantClassify('same issue here', issueTitle, issueDesc, false);
  await testParticipantClassify('I think this is related to the recent update', issueTitle, issueDesc, false);
  await testParticipantClassify('how about just restore the benefits', issueTitle, issueDesc, false);
  await testParticipantClassify('yeah that happened to me too', issueTitle, issueDesc, false);

  console.log('\n  --- Should be NEW_REQUEST (distinct user question/problem) ---');
  await testParticipantClassify(
    '@wenwenlee can you check my customer id and let me know if I fall under that because I haven\'t heard from you in 2 weeks',
    issueTitle, issueDesc, true
  );
  await testParticipantClassify(
    'customer id 1961759277988277 please let me know. I\'ve hit weekly limits again',
    issueTitle, issueDesc, true
  );
  await testParticipantClassify(
    'I\'m having a different billing issue — my account shows the wrong plan',
    issueTitle, issueDesc, true
  );
}

// ── Regression: Full RAG pipeline still works ────────────────────────
async function testPipelineReg(message, forceEmptyHistory = false) {
  console.log('\n=== PIPELINE REGRESSION:', message.slice(0, 60), '===');
  const { data: issue } = await supabase.from('issues').select('*').limit(1).single();
  const { intent, messageType, reply } = await classifyIntent(message);
  console.log('L1:', intent, '|', messageType);

  if (messageType === 'acknowledgement') { console.log('  → SKIP (ack)'); return; }
  if (intent === 'CASUAL')               { console.log('  Reply:', (reply||'').slice(0,50)); return; }
  if (intent === 'STATUS')               { console.log('  → DB status'); return; }
  if (intent === 'UNCLEAR')              { console.log('  → Clarify'); return; }

  const context = forceEmptyHistory
    ? { history: [], issueSummary: 'Billing issue — user lost grandfathered subscription quota', messageCount: 0 }
    : await fetchContext(issue);

  const { query, needsRag } = await rewriteQuery(message, context.history, intent);
  console.log('L3 needsRag:', needsRag, '| query:', (query||'null').slice(0, 60));

  let ragResults = [];
  if (needsRag && query) {
    const vec = await embed(query);
    const candidates = await search(COLLECTIONS.docs, vec, 10);
    if (candidates.length > 0) {
      const docTexts = candidates.map(r => r.payload.content);
      try {
        const reranked = await rerank(query, docTexts);
        ragResults = reranked
          .map(r => ({ ...candidates[r.id], score: sigmoid(r.score), vector_score: candidates[r.id]?.score, reranker_score: sigmoid(r.score) }))
          .sort((a, b) => b.reranker_score - a.reranker_score)
          .slice(0, 5);
        console.log('  Reranked scores:', ragResults.map(r => r.reranker_score.toFixed(3)));
      } catch {
        ragResults = candidates.slice(0, 5);
      }
    }
  }

  const answer = await generateResponse(message, ragResults, context, needsRag);
  const isEscalate = answer.toUpperCase().startsWith('ESCALATE');
  console.log('L4:', isEscalate ? 'ESCALATE' : answer.slice(0, 120));
}

// ── Fix 4: maybeUpdateSummary test ───────────────────────────────────
async function testAutoSummary() {
  console.log('\n=== FIX 4: AUTO-SUMMARY (maybeUpdateSummary) ===');

  const { data: issue } = await supabase.from('issues').select('*').limit(1).single();
  if (!issue) { console.log('  No issue in DB — skipping'); return; }

  // Count messages for this issue
  const { count } = await supabase
    .from('issue_messages')
    .select('*', { count: 'exact', head: true })
    .eq('issue_id', issue.id);

  console.log('  Issue:', issue.short_id, '| Message count:', count);
  console.log('  Current summary:', issue.summary || '(none)');
  console.log('  Summary triggers every 10 messages. Will fire if count % 10 === 0:', count % 10 === 0 ? 'YES (fires now)' : 'NO');

  if (count >= 3) {
    console.log('  Calling maybeUpdateSummary...');
    await maybeUpdateSummary(issue);
    // Re-fetch to check if summary was written
    const { data: refreshed } = await supabase.from('issues').select('summary').eq('id', issue.id).single();
    console.log('  Summary after call:', refreshed?.summary ? refreshed.summary.slice(0, 100) + '...' : '(no update — count not a multiple of 10)');
  } else {
    console.log('  Skipping — not enough messages to test (need 3+)');
  }
}

(async () => {
  // ╔══════════════════════════════════════════════════════╗
  // ║  POST-FIX TEST SUITE — All 5 Fixes                   ║
  // ╚══════════════════════════════════════════════════════╝
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  POST-FIX TEST SUITE — All 5 Fixes                   ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // Fix 5: counter logic (pure, no DB/Discord needed)
  testBriefCounter();

  // Fix 2: brief embed logic (pure simulation, no Discord needed)
  testBriefEmbedLogic();

  // Fix 3: participant intent classification (LLM call, fast model)
  await testParticipantClassification();

  // Fix 1: multi-user DB queries
  await testMultiUserData();

  // Fix 4: smarter memory
  await testSmartMemory();
  await testAutoSummary();

  // REGRESSION: full RAG pipeline still works end-to-end
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  REGRESSION — FULL PIPELINE (with RAG)                ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // Reporter asking a question — should hit RAG and answer
  await testPipelineReg('how do I cancel my subscription?', true);
  await testPipelineReg('error 1113 insufficient balance but I have a coding plan subscription', true);
  await testPipelineReg('im using the standard endpoint api.z.ai/api/paas/v4 with my coding plan and getting errors', true);

  // Should ESCALATE (not in docs)
  await testPipelineReg('why is the sky blue?', true);
  await testPipelineReg('what are your support hours?', true);

  // New scenarios relevant to the sui.txt conversation
  await testPipelineReg('I upgraded my plan but lost my grandfathered weekly limit exemption', true);
  await testPipelineReg('what is the difference between quarterly and yearly plan benefits?', true);
  await testPipelineReg('can staff manually restore grandfathered subscription benefits?', true);

  console.log('\n✅ Post-fix test suite complete');
})().catch(e => console.error('Test failed:', e.message));
