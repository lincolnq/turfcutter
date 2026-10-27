#!/usr/bin/env bash
# Load the exported data into wrangler's local R2 emulator and apply the D1 migration.
# Run after `python3 export_data.py` from the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in full.bin.gz walk.bin.gz names.json.gz doors.json.gz barriers.bin.gz; do
  npx wrangler r2 object put "turf-data/$f" --file "../data/export/$f" --local
done
npx wrangler d1 migrations apply turf --local
echo "done. start the app with: npm run dev"
