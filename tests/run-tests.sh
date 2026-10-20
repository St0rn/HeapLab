#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node tests/test_chunk_structures.cjs
node tests/test_source_sim.cjs
python3 -m unittest discover -s tests -v
