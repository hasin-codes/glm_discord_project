const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const { generateTopicSummaries } = require('./topicSummarizer');

// Lazy-initialized Supabase client (avoids crash when env vars missing at require time)
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
  }
  return _supabase;
}

/**
 * Step 7: Write cluster results to Supabase.
 * Reads cluster assignments and Qdrant payloads to build cluster metadata and join rows.
 *
 * Table schemas (ground truth: sql/pipeline_clusters.sql):
 *   pipeline_clusters: id, batch_id, cluster_id, start_timestamp, end_timestamp,
 *                      message_count, unique_users, avg_boundary_score, created_at
 *   pipeline_cluster_messages: id, batch_id, cluster_id, message_id,
 *                              context_block_id, channel_id, user_id, created_at
 *
 * @param {Map<string, number>} clusterAssignments - contextBlockId → clusterId
 * @param {Array<{id: string, payload: object}>} qdrantPoints - points from Qdrant for this batch
 * @param {string} batchId
 * @param {object} [client] - Optional Supabase client override (for testing)
 * @returns {Promise<{clusterRows: number, messageRows: number}>}
 */
async function storeClusterResults(clusterAssignments, qdrantPoints, batchId, client) {
  const db = client || getSupabase();
  // Group points by cluster (exclude noise = cluster -1)
  const clusterMap = new Map();

  for (const point of qdrantPoints) {
    const clusterId = clusterAssignments.get(point.id);
    if (clusterId === undefined || clusterId === -1) continue;

    if (!clusterMap.has(clusterId)) {
      clusterMap.set(clusterId, []);
    }
    clusterMap.get(clusterId).push(point);
  }

  if (clusterMap.size === 0) {
    logger.warn('storeResults', 'No non-noise clusters to write');
    return { clusterRows: 0, messageRows: 0 };
  }

  // Build cluster rows and message rows
  const clusterRows = [];
  const messageRows = [];

  for (const [clusterId, points] of clusterMap) {
    // Aggregate cluster metadata
    const startTimestamp = points.reduce((min, p) =>
      p.payload.startTimestamp < min ? p.payload.startTimestamp : min,
      points[0].payload.startTimestamp
    );
    const endTimestamp = points.reduce((max, p) =>
      p.payload.endTimestamp > max ? p.payload.endTimestamp : max,
      points[0].payload.endTimestamp
    );

    // Count unique messages (deduplicate by message_id since context blocks overlap)
    const uniqueMessageIds = new Set();
    const uniqueUserIds = new Set();
    const boundaryScores = [];

    for (const p of points) {
      for (const mid of (p.payload.messageIds || [])) {
        uniqueMessageIds.add(mid);
      }
      // user_id is not directly on the payload — we store anchorMessageId
      // uniqueUsers will be approximated from distinct messageIds if needed downstream
      if (p.payload.segmentBoundaryScore !== null && p.payload.segmentBoundaryScore !== undefined) {
        boundaryScores.push(p.payload.segmentBoundaryScore);
      }
    }

    const avgBoundaryScore = boundaryScores.length > 0
      ? boundaryScores.reduce((a, b) => a + b, 0) / boundaryScores.length
      : null;

    clusterRows.push({
      batch_id: batchId,
      cluster_id: clusterId,
      start_timestamp: startTimestamp,
      end_timestamp: endTimestamp,
      message_count: uniqueMessageIds.size,
      unique_users: 0, // not available from payload without user_id; set 0 for now
      avg_boundary_score: avgBoundaryScore,
    });

    // Build message join rows
    for (const p of points) {
      for (const mid of (p.payload.messageIds || [])) {
        messageRows.push({
          batch_id: batchId,
          cluster_id: clusterId,
          message_id: mid,
          context_block_id: p.id,
          channel_id: p.payload.channelId || null,
          user_id: null, // not in payload
        });
      }
    }
  }

  // Write to Supabase — insert cluster rows
  const { error: clusterError } = await db
    .from('pipeline_clusters')
    .insert(clusterRows);

  if (clusterError) {
    throw new Error(`Failed to insert pipeline_clusters: ${clusterError.message}`);
  }

  // Write message join rows
  // Supabase has a default row limit per insert; chunk if needed
  const msgChunkSize = 500;
  let msgInserted = 0;

  for (let i = 0; i < messageRows.length; i += msgChunkSize) {
    const chunk = messageRows.slice(i, i + msgChunkSize);
    const { error: msgError } = await db
      .from('pipeline_cluster_messages')
      .insert(chunk);

    if (msgError) {
      throw new Error(`Failed to insert pipeline_cluster_messages: ${msgError.message}`);
    }
    msgInserted += chunk.length;
  }

  logger.info('storeResults', 'Cluster results written to Supabase', {
    clusterRows: clusterRows.length,
    messageRows: msgInserted,
    noiseClusters: clusterAssignments.size - [...clusterMap.keys()].length,
  });

  return { clusterRows: clusterRows.length, messageRows: msgInserted };
}

/**
 * Store LLM-based segment classifications to Supabase.
 * Groups segments by topic label and writes to pipeline_clusters + pipeline_cluster_messages.
 * Also generates LLM summaries for each topic.
 *
 * @param {Map<number, string>} classifications - segmentIndex → topicLabel
 * @param {Array<{segmentIndex: number, messages: Array, boundaryScore: number|null, startTimestamp: string, endTimestamp: string}>} segments
 * @param {string} batchId
 * @param {object} [client] - Optional Supabase client override (for testing)
 * @returns {Promise<{clusterRows: number, messageRows: number, summaryRows: number}>}
 */
async function storeSegmentClassifications(classifications, segments, batchId, client) {
  const db = client || getSupabase();

  // Group segments by topic label
  const labelGroups = new Map();
  for (const segment of segments) {
    const label = classifications.get(segment.segmentIndex) || 'uncategorized';
    if (!labelGroups.has(label)) {
      labelGroups.set(label, []);
    }
    labelGroups.get(label).push(segment);
  }

  if (labelGroups.size === 0) {
    logger.warn('storeResults', 'No classifications to write');
    return { clusterRows: 0, messageRows: 0, summaryRows: 0 };
  }

  const clusterRows = [];
  const messageRows = [];
  let clusterIdCounter = 0;

  for (const [topicLabel, groupSegments] of labelGroups) {
    const clusterId = clusterIdCounter++;

    // Aggregate stats across all segments in this label group
    const uniqueMessageIds = new Set();
    const uniqueUserIds = new Set();
    const boundaryScores = [];
    let minTimestamp = groupSegments[0].startTimestamp;
    let maxTimestamp = groupSegments[0].endTimestamp;

    for (const seg of groupSegments) {
      if (seg.startTimestamp < minTimestamp) minTimestamp = seg.startTimestamp;
      if (seg.endTimestamp > maxTimestamp) maxTimestamp = seg.endTimestamp;
      if (seg.boundaryScore !== null && seg.boundaryScore !== undefined) {
        boundaryScores.push(seg.boundaryScore);
      }
      for (const msg of seg.messages) {
        uniqueMessageIds.add(msg.message_id);
        if (msg.user_id) uniqueUserIds.add(msg.user_id);
      }
    }

    const avgBoundaryScore = boundaryScores.length > 0
      ? boundaryScores.reduce((a, b) => a + b, 0) / boundaryScores.length
      : null;

    clusterRows.push({
      batch_id: batchId,
      cluster_id: clusterId,
      topic_label: topicLabel,
      start_timestamp: minTimestamp,
      end_timestamp: maxTimestamp,
      message_count: uniqueMessageIds.size,
      unique_users: uniqueUserIds.size,
      avg_boundary_score: avgBoundaryScore,
    });

    // Build message join rows
    for (const seg of groupSegments) {
      for (const msg of seg.messages) {
        messageRows.push({
          batch_id: batchId,
          cluster_id: clusterId,
          message_id: msg.message_id,
          context_block_id: seg.segmentIndex.toString(), // segment index as reference
          channel_id: msg.channel_id || null,
          user_id: msg.user_id || null,
        });
      }
    }
  }

  // Write cluster rows
  const { error: clusterError } = await db
    .from('pipeline_clusters')
    .insert(clusterRows);

  if (clusterError) {
    throw new Error(`Failed to insert pipeline_clusters: ${clusterError.message}`);
  }

  // Write message join rows in chunks
  const msgChunkSize = 500;
  let msgInserted = 0;

  for (let i = 0; i < messageRows.length; i += msgChunkSize) {
    const chunk = messageRows.slice(i, i + msgChunkSize);
    const { error: msgError } = await db
      .from('pipeline_cluster_messages')
      .insert(chunk);

    if (msgError) {
      throw new Error(`Failed to insert pipeline_cluster_messages: ${msgError.message}`);
    }
    msgInserted += chunk.length;
  }

  // Generate LLM summaries for each topic
  logger.info('storeResults', 'Generating LLM topic summaries...');
  const topicSummaries = await generateTopicSummaries(classifications, segments, batchId);
  
  // Write summaries to database
  if (topicSummaries.length > 0) {
    const { error: summaryError } = await db
      .from('pipeline_topic_summaries')
      .insert(topicSummaries);
    
    if (summaryError) {
      logger.error('storeResults', 'Failed to insert topic summaries', { error: summaryError.message });
      // Don't throw - summaries are nice-to-have, not critical
    } else {
      logger.info('storeResults', `Inserted ${topicSummaries.length} topic summaries`);
    }
  }

  logger.info('storeResults', 'Segment classifications written to Supabase', {
    clusterRows: clusterRows.length,
    messageRows: msgInserted,
    summaryRows: topicSummaries.length,
    topicLabels: Array.from(labelGroups.keys()),
  });

  return { 
    clusterRows: clusterRows.length, 
    messageRows: msgInserted,
    summaryRows: topicSummaries.length,
  };
}

module.exports = { storeClusterResults, storeSegmentClassifications };
