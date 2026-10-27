#!/usr/bin/env bash
# Upload the exported data to the real R2 bucket and apply the D1 migration remotely (needs `wrangler login`).
set -euo pipefail
cd "$(dirname "$0")/.."
for f in full.bin.gz walk.bin.gz names.json.gz doors.json.gz barriers.bin.gz; do
  npx wrangler r2 object put "turf-data/$f" --file "../data/export/$f" --remote
done
npx wrangler d1 migrations apply turf --remote
