const { QdrantClient } = require('@qdrant/js-client-rest');

const client = new QdrantClient({
  url:    process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY
});

const COLLECTIONS = {
  docs:      'docs_chunks',
  cases:     'resolved_cases',
  tribal:    'tribal_knowledge',
  community: 'community_knowledge'
};

// Qwen3-embedding-0.6b outputs 1024 dimensions
const VECTOR_SIZE = 256;

async function ensureCollection(name) {
  try {
    await client.getCollection(name);
    console.log(`[qdrant] Collection "${name}" already exists`);
  } catch {
    await client.createCollection(name, {
      vectors: {
        size:     VECTOR_SIZE,
        distance: 'Cosine'
      }
    });
    console.log(`[qdrant] Collection "${name}" created`);
  }
}

async function upsert(collectionName, points) {
  await client.upsert(collectionName, {
    wait:   true,
    points
  });
}

async function search(collectionName, vector, limit = 5, filter = null) {
  const params = { vector, limit, with_payload: true };
  if (filter) params.filter = filter;
  const results = await client.search(collectionName, params);
  return results;
}

async function initCollections() {
  for (const name of Object.values(COLLECTIONS)) {
    await ensureCollection(name);
  }
}

module.exports = {
  client,
  COLLECTIONS,
  VECTOR_SIZE,
  ensureCollection,  // exported now
  upsert,
  search,
  initCollections
};