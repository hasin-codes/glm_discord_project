#!/usr/bin/env python3
"""
HDBSCAN clustering via stdin/stdout.
Reads JSON from stdin, writes JSON to stdout.
No file I/O — stdin only, stdout only.

Note: Uses euclidean metric on pre-normalized vectors, which is
mathematically equivalent to cosine distance for unit vectors.
"""

import sys
import json
import numpy as np

try:
    import hdbscan
except ImportError:
    print(json.dumps({"error": "hdbscan not installed. Run: pip install hdbscan numpy scikit-learn"}))
    sys.exit(1)


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    points = data.get("points", [])
    config = data.get("config", {})

    min_cluster_size = config.get("minClusterSize", 5)
    min_samples = config.get("minSamples", 3)

    if len(points) == 0:
        print(json.dumps({"assignments": []}))
        return

    ids = [p["id"] for p in points]
    vectors = np.array([p["vector"] for p in points], dtype=np.float64)

    # HDBSCAN with euclidean metric on pre-normalized vectors
    # For unit vectors: euclidean distance = sqrt(2 - 2*cosine_similarity)
    # So clustering on normalized vectors with euclidean ≈ cosine
    clusterer = hdbscan.HDBSCAN(
        metric="euclidean",
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        cluster_selection_method="eom",
        core_dist_n_jobs=-1,  # Use all CPU cores
    )

    try:
        labels = clusterer.fit_predict(vectors)
    except Exception as e:
        print(json.dumps({"error": f"Clustering failed: {str(e)}"}))
        sys.exit(1)

    assignments = [
        {"id": str(id_), "clusterId": int(label)}
        for id_, label in zip(ids, labels)
    ]

    # Print warnings to stderr so they don't corrupt stdout JSON
    if clusterer.labels_ is not None:
        noise_count = int(np.sum(labels == -1))
        unique_clusters = len(set(labels) - {-1})
        print(f"[cluster.py] Clusters: {unique_clusters}, Noise: {noise_count}", file=sys.stderr)

    print(json.dumps({"assignments": assignments}))


if __name__ == "__main__":
    main()
