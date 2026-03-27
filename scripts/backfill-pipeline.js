/**
 * Backfill Pipeline Script
 * 
 * Processes historical messages from community_messages_clean
 * Runs automatically on first deployment, then disabled
 * 
 * Usage:
 *   node scripts/backfill-pipeline.js
 * 
 * Or set AUTO_BACKFILL=true in env to run on bot startup
 */

require('dotenv').config();

async function backfill() {
  console.log('🚀 Starting backfill pipeline...');
  console.log('Processing last 30 days of messages...');
  
  // Set backfill hours BEFORE requiring runPipeline
  process.env.PIPELINE_BACKFILL_HOURS = '720'; // 30 days
  
  // Force reload of pipeline config
  delete require.cache[require.resolve('../pipeline/src/index')];
  delete require.cache[require.resolve('../pipeline/pipeline.config')];
  
  const { runPipeline } = require('../pipeline/src/index');
  
  try {
    await runPipeline();
    console.log('✅ Backfill complete!');
    console.log('');
    console.log('Check your data in Supabase:');
    console.log('  SELECT COUNT(*) FROM pipeline_clusters;');
    console.log('  SELECT COUNT(*) FROM pipeline_topic_summaries;');
    console.log('  SELECT topic_label, message_count, sentiment, severity');
    console.log('  FROM pipeline_clusters ORDER BY message_count DESC LIMIT 10;');
  } catch (err) {
    console.error('❌ Backfill failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  backfill();
}

module.exports = { backfill };
