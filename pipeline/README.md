# Semantic Boundary Detection Pipeline

A batch pipeline that runs every 12 hours to process cleaned Discord general chat messages from Supabase. It detects topic shifts using TextTiling with embedding-based cosine similarity, builds semantically clean context blocks within each topic segment, embeds and stores them in Qdrant, clusters them with HDBSCAN, and writes structured cluster data back to Supabase.

**Why this exists:** Naive sliding windows over general chat blend unrelated topics (API errors + billing questions + random chat in the same window), producing poor embeddings and useless clusters. This pipeline detects where topics actually shift first, then builds context windows only within detected segments — dramatically improving downstream cluster quality.

---

## Quick Start

```bash
# Run the pipeline manually
node pipeline/src/index.js

# Run all tests
node --test pipeline/tests/*.test.js

# Run a specific test file
node --test pipeline/tests/boundaryDetection.test.js
```

---

## Environment Variables

All variables are read from `process.env`. The pipeline validates required vars at startup and throws a clear error listing any missing ones.

### Required

| Variable | Description |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account ID for Workers AI API |
| `CF_API_TOKEN` | Cloudflare API token with Workers AI access |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service key (needs read/write access — NOT the anon key) |
| `QDRANT_URL` | Qdrant instance URL |
| `QDRANT_API_KEY` | Qdrant API key |
| `QDRANT_PIPELINE_COLLECTION` | Qdrant collection name for pipeline vectors |
| `GENERAL_CHAT_CHANNEL_ID` | Discord channel ID for the general chat channel |

### Optional

| Variable | Description |
|---|---|
| `REDIS_URL` | Redis URL for distributed locking and batch tracking. If unavailable, pipeline runs in degraded mode (no lock, risk of duplicate runs). |
| `CLOUDFLARE_EMBEDDING_MODEL` | Embedding model name. Defaults to `@cf/baai/bge-large-en-v1.5`. Must match the model used by the rest of the project. |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  STEP 1: Fetch cleaned messages from Supabase   │
│  (cursor-based pagination, incremental via      │
│   message_ingestion_state)                       │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 2: Boundary Detection (TextTiling)        │
│  - Embed each message individually              │
│  - Sliding-window cosine similarity curve       │
│  - Depth-score valley detection → boundaries    │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 3: Context Block Construction             │
│  - Sliding window of 3 messages per segment     │
│  - Never crosses segment boundaries             │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 4: Final Embedding (Cloudflare Workers AI)│
│  - Embed context block text                     │
│  - Normalize to unit vectors                    │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 5: Upsert to Qdrant                       │
│  - Batch upsert with metadata payload           │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 6: HDBSCAN Clustering (Python subprocess) │
│  - Vectors piped via stdin, results via stdout  │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 7: Write clusters to Supabase             │
│  - pipeline_clusters (metadata)                 │
│  - pipeline_cluster_messages (message links)    │
└─────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Two embedding passes:** Step 2 uses cheap per-message embeddings for boundary detection only. Step 4 embeds the assembled context blocks. These are never mixed.
- **Depth scores, not raw thresholds:** Boundary detection uses depth scoring (distance from neighboring peaks) instead of raw similarity thresholds, making it robust across different conversation volumes.
- **Redis distributed lock:** Prevents concurrent pipeline runs. Falls back to degraded mode if Redis is unavailable.
- **Idempotent:** Tracks last batch end timestamp in Redis. Re-running on the same window won't duplicate data.

---

## Python Setup on Railway

HDBSCAN clustering runs as a Python subprocess (not a Node.js package — the `hdbscanjs` npm package is outdated and broken). Railway supports Python via the build command.

### 1. Create a `Pipfile` in project root (if not present)

```toml
[packages]
hdbscan = ">=0.8.40"
numpy = ">=1.24.0"
scikit-learn = ">=1.3.0"
```

### 2. Update Railway build command

```bash
pip install hdbscan numpy scikit-learn && npm install
```

### 3. Verify Python is available

Railway's Node.js environment includes Python 3. The pipeline calls `python3` via `child_process.spawn`. If Python is not found (exit code 127), the pipeline throws a clear error: `"python3 not found — HDBSCAN clustering requires Python 3"`.

---

## Supabase Tables

### Source (read-only)

**`community_messages_clean`** — cleaned Discord messages ingested by the existing pipeline.

| Column | Type |
|---|---|
| `id` | BIGSERIAL PK |
| `message_id` | TEXT UNIQUE |
| `channel_id` | TEXT |
| `user_id` | TEXT |
| `username` | TEXT |
| `content` | TEXT |
| `timestamp` | TIMESTAMPTZ |
| `created_at` | TIMESTAMPTZ |

### Output (write-only)

**`pipeline_clusters`** — one row per detected cluster per batch.

| Column | Type |
|---|---|
| `id` | BIGSERIAL PK |
| `batch_id` | TEXT |
| `cluster_id` | INTEGER |
| `start_timestamp` | TIMESTAMPTZ |
| `end_timestamp` | TIMESTAMPTZ |
| `message_count` | INTEGER |
| `unique_users` | INTEGER |
| `avg_boundary_score` | DOUBLE PRECISION |
| `created_at` | TIMESTAMPTZ |

**`pipeline_cluster_messages`** — one row per message-cluster link.

| Column | Type |
|---|---|
| `id` | BIGSERIAL PK |
| `batch_id` | TEXT |
| `cluster_id` | INTEGER |
| `message_id` | TEXT |
| `context_block_id` | TEXT |
| `channel_id` | TEXT |
| `user_id` | TEXT |
| `created_at` | TIMESTAMPTZ |

### First-time setup

Run the SQL migrations in Supabase SQL Editor before the first pipeline run:

```bash
# Cluster output tables
psql < sql/pipeline_clusters.sql

# Source table (if not already created by the ingestion pipeline)
psql < sql/community_messages_clean.sql
```

---

## Tuning Boundary Detection

All tunable constants are in `pipeline/pipeline.config.js`:

| Constant | Default | Effect |
|---|---|---|
| `BOUNDARY_WINDOW_SIZE` | 3 | Messages per side of boundary candidate. Higher = smoother curve, less sensitive. |
| `BOUNDARY_DEPTH_THRESHOLD` | 0.15 | Minimum depth score to declare a boundary. Lower = more boundaries (more segments). |
| `BOUNDARY_SMOOTHING_WINDOW` | 3 | Moving average window for depth scores. Higher = less noise, less responsive. |
| `MIN_SEGMENT_SIZE` | 3 | Discard boundaries that create segments smaller than this. |
| `MAX_SEGMENT_SIZE` | 80 | Force-split segments larger than this at their midpoint. |
| `CONTEXT_WINDOW_SIZE` | 3 | Messages per context block. Each block is embedded as one unit. |
| `HDBSCAN_MIN_CLUSTER_SIZE` | 5 | Minimum points to form a cluster. Higher = fewer, larger clusters. |
| `HDBSCAN_MIN_SAMPLES` | 3 | Core point threshold. Higher = more points classified as noise. |

**Tips:**
- If too many tiny clusters appear, increase `HDBSCAN_MIN_CLUSTER_SIZE` or `BOUNDARY_DEPTH_THRESHOLD`.
- If topics are getting merged that shouldn't be, decrease `BOUNDARY_DEPTH_THRESHOLD`.
- If the pipeline is slow, reduce `EMBEDDING_CONCURRENCY` or increase `EMBEDDING_BATCH_DELAY_MS` to avoid rate limits.

---

## Logging

All output is structured JSON (one object per line):

```json
{
  "level": "info",
  "timestamp": "2026-03-27T12:00:00.000Z",
  "batchId": "uuid-here",
  "step": "orchestrator",
  "message": "Pipeline complete",
  "data": {
    "durationMs": 45000,
    "messageCount": 1200,
    "segmentCount": 45,
    "contextBlockCount": 1150,
    "clusterCount": 12,
    "messageRows": 1100
  }
}
```

Key logged events: pipeline start, boundary detection stats, context block count, embedding success/failure counts, Qdrant upsert count, cluster stats, Supabase write count, pipeline completion with total duration.

---

## File Structure

```
/pipeline
  /src
    index.js                  ← Orchestrator — runs the full pipeline
    fetchMessages.js          ← Step 1: Supabase cursor-based message fetch
    boundaryDetection.js      ← Step 2: TextTiling cosine boundary detector
    contextBuilder.js         ← Step 3: Context block construction
    embedder.js               ← Steps 2 & 4: Cloudflare Workers AI embedding
    qdrantClient.js           ← Step 5: Qdrant upsert + batch retrieval
    clusterRunner.js          ← Step 6: HDBSCAN via Python subprocess
    storeResults.js           ← Step 7: Cluster results to Supabase
    batchTracker.js           ← Redis distributed lock + batch dedup
    logger.js                 ← Structured JSON logger
  /scripts
    cluster.py                ← Python HDBSCAN (stdin → stdout)
  /tests
    boundaryDetection.test.js
    contextBuilder.test.js
    embedder.test.js
    qdrantClient.test.js
    clusterRunner.test.js
    storeResults.test.js
    integration.test.js
  pipeline.config.js          ← All tunable constants
  requirements.txt            ← Python dependencies for Railway
  README.md                   ← This file
```

---

## Known Limitations

- **Segment-level granularity, not token-level.** Boundaries are detected between messages, not within a single message. If one long message covers two topics, it stays in one segment. This is an inherent trade-off of message-level processing.
- **No language detection.** The embedding model handles multilingual input. No language-specific preprocessing is applied, which works well for multilingual communities but means no language-aware optimizations.
- **Short messages embed poorly.** Messages like `"ok"`, `"lol"`, `"yes"` produce noisy embeddings. The cleaning stage is responsible for filtering these; the pipeline does not skip them.
- **HDBSCAN requires Python.** The clustering step spawns a Python subprocess. Ensure Python 3 and the required packages are available in the deployment environment.
- **Not real-time.** This is a batch-only pipeline designed for 12-hour runs. It does not process messages as they arrive.

---

## Safety Guarantees

- **No existing code touched.** All pipeline code lives in `/pipeline`. No bot, RAG, or moderation files were modified.
- **Distributed lock always released.** The Redis lock is released in a `finally` block — it cannot leak even on crash.
- **Partial failures roll back.** Supabase writes for a batch either fully succeed or fully fail. Half-written clusters are not possible.
- **Failed embeddings are isolated.** If one context block's embedding fails, only that block is skipped. The rest of the pipeline continues.
- **Idempotent re-runs.** Batch tracking via Redis prevents re-processing the same messages.
