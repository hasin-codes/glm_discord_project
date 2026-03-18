// lib/rewriter.js
const { chat } = require('./cloudflare');

const REWRITE_ONLY_PROMPT = `You are a search query optimizer.
Convert the user message into a clean 3-8 word semantic search query.
Remove emotional language, filler words, pronouns.
Keep technical terms, product names, action verbs.
Respond with ONLY the query string. No explanation, no JSON, no quotes.

Examples:
"what payment methods do you accept?" → accepted payment methods
"my app keeps crashing on login" → app crash login authentication
"how do I cancel my subscription?" → cancel subscription steps
"ugh nothing is working" → product functionality issues`;

async function rewriteQueryOnly(userMessage) {
  try {
    const result = await chat(REWRITE_ONLY_PROMPT, [
      { role: 'user', content: userMessage }
    ]);
    const query = result.trim().replace(/^["']|["']$/g, '').slice(0, 100);
    return { query, needsRag: true, reason: 'No history — must search docs' };
  } catch (err) {
    console.error('[rewriter] rewriteQueryOnly failed:', err.message);
    return { query: userMessage.slice(0, 100), needsRag: true, reason: 'Fallback' };
  }
}

const REWRITER_PROMPT = `You are a search query optimizer for a product support knowledge base.

Given a user message and recent conversation history, output a JSON object with:
- "query": a clean semantic search query (or null if no search needed)
- "needsRag": true or false
- "reason": one short sentence explaining your decision

Rules for needsRag: false (do NOT search):
- Message is a status check ("any update?", "when will this be fixed?")
- Message is conversational follow-up to something already answered
- Message is clarification of something already in the conversation
- Message asks about their specific issue (not general product questions)

Rules for needsRag: true (DO search):
- Message asks a general product question (features, pricing, how-to, policies)
- Message describes a problem and needs solution from docs
- Message asks about something not yet discussed in the conversation

Query optimization rules:
- Remove emotional language ("frustrated", "annoying", "please")
- Remove filler ("I want to know", "can you tell me", "I was wondering")  
- Resolve pronouns using conversation history ("it" → the actual thing)
- Keep technical terms, product names, action verbs
- Output 3-8 words maximum
- Use noun phrases not full sentences

Example inputs and outputs:
User: "what payment methods do you accept?"
History: []
Output: {"query": "accepted payment methods", "needsRag": true, "reason": "General product question about payments"}

User: "ugh still having the same problem as before"
History: [{"role":"user","content":"my login keeps failing"}, {"role":"assistant","content":"..."}]
Output: {"query": "login failure authentication error", "needsRag": true, "reason": "Complaint about login issue needing docs"}

User: "any update on my issue?"
History: [...]
Output: {"query": null, "needsRag": false, "reason": "Status check, not a knowledge question"}

User: "ok thanks that makes sense"
History: [...]
Output: {"query": null, "needsRag": false, "reason": "Conversational acknowledgement"}

User: "when does the refund come through?"
History: [{"role":"assistant","content":"Refunds take 5-10 business days..."}]
Output: {"query": null, "needsRag": false, "reason": "Already answered in conversation"}

Respond with ONLY valid JSON. No markdown, no explanation outside the JSON.`;

// Robust JSON extraction — handles LLM quirks
function extractJSON(text) {
  // Find the first { and last } to extract just the JSON object
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  let jsonStr = text.slice(start, end + 1);

  // Fix common LLM JSON mistakes
  // Remove trailing commas before } or ]
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

async function rewriteQuery(userMessage, history, intent = 'QUESTION') {
  // If no conversation history exists, we MUST search RAG for questions/complaints
  // Cannot claim "already answered" with empty history
  if (history.length === 0 && ['QUESTION', 'COMPLAINT', 'UNCLEAR'].includes(intent)) {
    const simpleResult = await rewriteQueryOnly(userMessage);
    return { ...simpleResult, needsRag: true, reason: 'No history — must search docs' };
  }

  const historyText = history
    .slice(-6) // last 6 messages for context
    .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
    .join('\n');

  const input = `Conversation history:\n${historyText || '(none)'}\n\nUser message: ${userMessage}`;

  try {
    const result = await chat(REWRITER_PROMPT, [
      { role: 'user', content: input }
    ]);

    const parsed = extractJSON(result);
    if (!parsed) {
      console.warn('[rewriter] Could not parse LLM response as JSON, using fallback');
      return {
        query:    userMessage.slice(0, 100),
        needsRag: true,
        reason:   'JSON parse failed — using raw message as query'
      };
    }

    // After parsing, normalize null values
    if (parsed.query === 'null' || parsed.query === '') parsed.query = null;

    // Validate shape
    if (typeof parsed.needsRag !== 'boolean') parsed.needsRag = true;
    if (parsed.needsRag && !parsed.query)     parsed.query = userMessage.slice(0, 100);

    console.log(`[rewriter] needsRag: ${parsed.needsRag} | query: "${parsed.query}" | reason: ${parsed.reason}`);
    return parsed;

  } catch (err) {
    console.error('[rewriter] Failed:', err.message);
    // Safe fallback: search with raw message
    return {
      query:    userMessage.slice(0, 100),
      needsRag: true,
      reason:   'Fallback — rewriter failed'
    };
  }
}

module.exports = { rewriteQuery };
