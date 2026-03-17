const OpenAI = require('openai');

// Native Cloudflare fetch — used for embeddings because the OpenAI-compatible
// endpoint returns zero vectors for qwen3-embedding-0.6b
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run`;
const EMBEDDING_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
const CHAT_MODEL      = '@cf/qwen/qwen3-30b-a3b-fp8';

// OpenAI SDK pointed at Cloudflare — only used for chat completions
const cf = new OpenAI({
  apiKey:  process.env.CF_API_TOKEN,
  baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/v1`
});

// Embed using native Cloudflare API (not OpenAI-compatible endpoint)
// Returns a single float array
async function embed(text) {
  const res = await fetch(`${CF_BASE}/${EMBEDDING_MODEL}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({ text: [text.slice(0, 8000)] })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cloudflare embed failed: ${res.status} ${err}`);
  }

  const json = await res.json();

  // Native API response: { result: { data: [[...floats...]] } }
  const vector = json?.result?.data?.[0];
  if (!vector || vector.length === 0) {
    throw new Error(`Empty embedding returned. Full response: ${JSON.stringify(json)}`);
  }

  return vector;
}

// Embed multiple strings — returns array of float arrays
async function embedBatch(texts) {
  const res = await fetch(`${CF_BASE}/${EMBEDDING_MODEL}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({ text: texts.map(t => t.slice(0, 8000)) })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cloudflare embedBatch failed: ${res.status} ${err}`);
  }

  const json = await res.json();
  const vectors = json?.result?.data;

  if (!vectors || vectors.length === 0) {
    throw new Error(`Empty embeddings returned. Full response: ${JSON.stringify(json)}`);
  }

  return vectors;
}

// Chat completion via OpenAI-compatible endpoint (works fine for generation)
async function chat(systemPrompt, messages) {
  const response = await cf.chat.completions.create({
    model:       CHAT_MODEL,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ]
  });
  return response.choices[0].message.content;
}

module.exports = { embed, embedBatch, chat, EMBEDDING_MODEL };