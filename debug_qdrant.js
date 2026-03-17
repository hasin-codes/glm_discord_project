require('dotenv').config();
const { QdrantClient } = require('@qdrant/js-client-rest');

const client = new QdrantClient({
  url:    process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY
});

async function main() {
  // 1. Check collection info
  const info = await client.getCollection('docs_chunks');
  console.log('Collection config:', JSON.stringify(info.config, null, 2));
  console.log('Points count:', info.points_count);

  // 2. Scroll to see what's actually stored
  const scroll = await client.scroll('docs_chunks', { limit: 1, with_vectors: true, with_payload: true });
  const point = scroll.points[0];
  console.log('\nStored point ID:', point.id);
  console.log('Stored vector length:', point.vector?.length);
  console.log('Stored vector first 5 values:', point.vector?.slice(0, 5));
  console.log('Payload:', point.payload?.content?.slice(0, 80));

  // 3. Embed a query and check
  const { embed } = require('./lib/cloudflare');
  const queryVec = await embed('what payment methods do you accept');
  console.log('\nQuery vector length:', queryVec.length);
  console.log('Query vector first 5 values:', queryVec.slice(0, 5));

  // 4. Check if vectors are all zeros
  const storedAllZero = point.vector?.every(v => v === 0);
  const queryAllZero  = queryVec.every(v => v === 0);
  console.log('\nStored vector all zeros?', storedAllZero);
  console.log('Query vector all zeros?',  queryAllZero);

  // 5. Try search
  const results = await client.search('docs_chunks', {
    vector: queryVec,
    limit: 3,
    with_payload: true
  });
  console.log('\nSearch results:', results.map(r => ({ score: r.score, content: r.payload?.content?.slice(0,50) })));
}

main().catch(e => console.error('Error:', e.message, e));