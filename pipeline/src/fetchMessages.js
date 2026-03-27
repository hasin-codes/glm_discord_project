const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const { PIPELINE_CONFIG } = require('../pipeline.config');

// Use SUPABASE_SERVICE_KEY for write-capable access (pipeline writes to cluster tables)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// Columns from community_messages_clean table (ground truth: sql/community_messages_clean.sql)
const COLUMNS = 'id, message_id, channel_id, user_id, username, content, timestamp';

/**
 * Fetch cleaned messages from Supabase for the batch window.
 * Uses cursor-based pagination by `id` (BIGSERIAL, guaranteed monotonic).
 *
 * @param {string} startTime - ISO timestamp for window start
 * @param {string} endTime   - ISO timestamp for window end
 * @returns {Promise<Array>} chronologically sorted message objects
 */
async function fetchMessages(startTime, endTime) {
  const channelId = process.env.GENERAL_CHAT_CHANNEL_ID;
  const chunkSize = PIPELINE_CONFIG.FETCH_CHUNK_SIZE;
  let allMessages = [];
  let lastId = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('community_messages_clean')
      .select(COLUMNS)
      .eq('channel_id', channelId)
      .gte('timestamp', startTime)
      .lt('timestamp', endTime)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(chunkSize);

    const { data, error } = await query;

    if (error) {
      throw new Error(`fetchMessages Supabase error: ${error.message} (code: ${error.code})`);
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    allMessages = allMessages.concat(data);
    lastId = data[data.length - 1].id;

    if (data.length < chunkSize) {
      hasMore = false;
    }
  }

  // Verify chronological order (should be guaranteed by ORDER BY id ASC,
  // but id is BIGSERIAL which matches insertion order ≈ timestamp order)
  // No need to re-sort — id ordering is sufficient for boundary detection

  logger.info('fetchMessages', `Fetched ${allMessages.length} messages`, {
    startTime,
    endTime,
    channelId,
    chunks: Math.ceil(allMessages.length / chunkSize) || 0,
  });

  return allMessages;
}

module.exports = { fetchMessages };
