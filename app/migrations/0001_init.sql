CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  label TEXT,
  root_lat REAL NOT NULL, root_lon REAL NOT NULL,
  params TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turfs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  turf_no INTEGER NOT NULL,
  doors INTEGER NOT NULL, length_m REAL NOT NULL, minutes REAL NOT NULL, approach_m REAL NOT NULL,
  edges TEXT NOT NULL,
  minx REAL, miny REAL, maxx REAL, maxy REAL
);
CREATE INDEX IF NOT EXISTS idx_turfs_batch ON turfs(batch_id);
CREATE INDEX IF NOT EXISTS idx_turfs_bbox ON turfs(minx, maxx, miny, maxy);
CREATE TABLE IF NOT EXISTS door_assign (
  door_id INTEGER PRIMARY KEY,
  turf_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assign_turf ON door_assign(turf_id);
