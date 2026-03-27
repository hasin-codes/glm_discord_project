const supabase = require('../supabase');

const RAW_TABLE = 'community_messages';
const CLEAN_TABLE = 'community_messages_clean';
const STATE_TABLE = 'message_ingestion_state';

/**
 * Delete raw messages older than retention period.
 * Only deletes messages that have been successfully cleaned.
 * 
 * @param {number} retentionDays - How many days to keep raw messages (default: 7)
 * @returns {Promise<{deleted: number, error: string|null}>}
 */
async function deleteOldRawMessages(retentionDays = 7) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  
  console.log(`[retention] Starting cleanup - deleting raw messages older than ${cutoff}`);
  
  try {
    // Step 1: Get all cleaned message IDs that are newer than cutoff
    // These are messages we want to keep (still within retention window)
    const { data: cleanedRecent, error: err1 } = await supabase
      .from(CLEAN_TABLE)
      .select('message_id')
      .gte('timestamp', cutoff);
    
    if (err1) {
      throw new Error(`Failed to fetch recent cleaned messages: ${err1.message}`);
    }
    
    const recentCleanedIds = new Set((cleanedRecent || []).map(c => c.message_id));
    
    // Step 2: Delete raw messages that are:
    // - Older than cutoff
    // - NOT in the recent cleaned set (i.e., they were cleaned before cutoff OR never cleaned)
    // We use a subquery approach to avoid loading all IDs into memory
    
    // First, get raw messages older than cutoff
    const { data: oldRaw, error: err2 } = await supabase
      .from(RAW_TABLE)
      .select('message_id')
      .lt('timestamp', cutoff)
      .limit(10000); // Safety limit
    
    if (err2) {
      throw new Error(`Failed to fetch old raw messages: ${err2.message}`);
    }
    
    if (!oldRaw || oldRaw.length === 0) {
      console.log('[retention] No old raw messages to delete');
      return { deleted: 0, error: null };
    }
    
    // Filter to only those that have been cleaned (exist in clean table)
    // We need to verify they exist in clean table before deleting
    const { data: verified, error: err3 } = await supabase
      .from(CLEAN_TABLE)
      .select('message_id')
      .in('message_id', oldRaw.map(r => r.message_id));
    
    if (err3) {
      throw new Error(`Failed to verify cleaned messages: ${err3.message}`);
    }
    
    const idsToDelete = (verified || []).map(v => v.message_id);
    
    if (idsToDelete.length === 0) {
      console.log('[retention] No verified messages to delete');
      return { deleted: 0, error: null };
    }
    
    // Step 3: Delete verified old raw messages
    const { error: deleteError } = await supabase
      .from(RAW_TABLE)
      .delete()
      .in('message_id', idsToDelete);
    
    if (deleteError) {
      throw new Error(`Failed to delete raw messages: ${deleteError.message}`);
    }
    
    console.log(`[retention] Deleted ${idsToDelete.length} raw messages older than ${cutoff}`);
    
    // Step 4: Update last cleanup timestamp
    await supabase
      .from(STATE_TABLE)
      .upsert({
        channel_id: 'retention_cleanup',
        last_message_id: null,
        last_processed_at: new Date().toISOString(),
      }, { onConflict: 'channel_id' });
    
    return { deleted: idsToDelete.length, error: null };
    
  } catch (err) {
    console.error('[retention] Cleanup failed:', err.message);
    return { deleted: 0, error: err.message };
  }
}

/**
 * Get the last retention cleanup timestamp.
 * @returns {Promise<Date|null>}
 */
async function getLastRetentionRun() {
  const { data, error } = await supabase
    .from(STATE_TABLE)
    .select('last_processed_at')
    .eq('channel_id', 'retention_cleanup')
    .maybeSingle();
  
  if (error || !data) {
    return null;
  }
  
  return new Date(data.last_processed_at);
}

/**
 * Check if retention cleanup should run (once per day).
 * @returns {Promise<boolean>}
 */
async function shouldRunRetention() {
  const lastRun = await getLastRetentionRun();
  if (!lastRun) {
    return true; // Never run before, run now
  }
  
  const now = Date.now();
  const hoursSinceLastRun = (now - lastRun.getTime()) / (1000 * 60 * 60);
  
  // Run once every 24 hours
  return hoursSinceLastRun >= 24;
}

module.exports = {
  deleteOldRawMessages,
  getLastRetentionRun,
  shouldRunRetention,
};
