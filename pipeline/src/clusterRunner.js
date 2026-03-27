const { spawn } = require('child_process');
const path = require('path');
const logger = require('./logger');
const { PIPELINE_CONFIG } = require('../pipeline.config');

const CLUSTER_SCRIPT = path.join(__dirname, '..', 'scripts', 'cluster.py');

/**
 * Run HDBSCAN clustering via Python subprocess.
 * Passes vectors via stdin, reads assignments from stdout.
 *
 * @param {Array<{id: string, vector: number[]}>} points
 * @returns {Promise<Map<string, number>>} contextBlockId → clusterId
 */
async function runClustering(points) {
  const minClusterSize = PIPELINE_CONFIG.HDBSCAN_MIN_CLUSTER_SIZE;
  const minSamples = PIPELINE_CONFIG.HDBSCAN_MIN_SAMPLES;
  const timeoutMs = PIPELINE_CONFIG.PYTHON_TIMEOUT_MS;

  // Edge case: too few points for meaningful clustering
  if (points.length < minClusterSize * 2) {
    logger.warn('clusterRunner', `Too few points (${points.length} < ${minClusterSize * 2}), assigning all to cluster 0`);
    const result = new Map();
    for (const p of points) {
      result.set(p.id, 0);
    }
    return result;
  }

  const input = JSON.stringify({
    points: points.map(p => ({ id: p.id, vector: p.vector })),
    config: { minClusterSize, minSamples },
  });

  return new Promise((resolve, reject) => {
    // Use python3 on Linux/Mac, python on Windows
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(pythonCmd, [CLUSTER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Python cluster subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);

      // Log stderr (contains HDBSCAN warnings/info)
      if (stderr.trim()) {
        logger.info('clusterRunner', 'Python stderr output', { stderr: stderr.trim().slice(0, 500) });
      }

      if (code === 127) {
        reject(new Error(
          `python3 not found (exit code 127). Install Python 3 and run: pip install hdbscan numpy scikit-learn`
        ));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Python cluster script exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      // Parse stdout JSON
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        reject(new Error(
          `Failed to parse Python output as JSON. Raw stdout: ${stdout.slice(0, 500)}`
        ));
        return;
      }

      if (parsed.error) {
        reject(new Error(`Python cluster error: ${parsed.error}`));
        return;
      }

      const assignments = parsed.assignments || [];
      const result = new Map();

      let noiseCount = 0;
      for (const a of assignments) {
        result.set(a.id, a.clusterId);
        if (a.clusterId === -1) noiseCount++;
      }

      // Check if all noise
      if (assignments.length > 0 && noiseCount === assignments.length) {
        logger.warn('clusterRunner', 'All points assigned to noise (cluster -1)');
      }

      const clusterIds = [...new Set(assignments.map(a => a.clusterId))].filter(c => c !== -1);
      const avgClusterSize = clusterIds.length > 0
        ? assignments.filter(a => a.clusterId !== -1).length / clusterIds.length
        : 0;

      logger.info('clusterRunner', 'Clustering complete', {
        totalPoints: points.length,
        clusterCount: clusterIds.length,
        noisePoints: noiseCount,
        avgClusterSize: avgClusterSize.toFixed(1),
      });

      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(
          `Python executable not found. Install Python 3 and run: pip install hdbscan numpy scikit-learn`
        ));
      } else {
        reject(new Error(`Failed to spawn Python: ${err.message}`));
      }
    });

    // Write input to stdin with proper error handling for large payloads
    proc.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to write to Python stdin: ${err.message}`));
    });

    // Write in chunks to avoid pipe buffer overflow
    const writeWithBackpressure = () => {
      return new Promise((resolveWrite, rejectWrite) => {
        const ok = proc.stdin.write(input, 'utf8');
        if (ok) {
          resolveWrite();
        } else {
          proc.stdin.once('drain', resolveWrite);
        }
      });
    };

    writeWithBackpressure()
      .then(() => {
        proc.stdin.end();
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

module.exports = { runClustering };
