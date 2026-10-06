CREATE TABLE roster_versions (
  version INTEGER PRIMARY KEY CHECK (typeof(version) = 'integer' AND version >= 1),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
  doc TEXT NOT NULL CHECK (length(doc) <= 262144)
);
CREATE TRIGGER roster_versions_append_only_update BEFORE UPDATE ON roster_versions
BEGIN SELECT RAISE(ABORT, 'roster versions are append-only'); END;
CREATE TRIGGER roster_versions_append_only_delete BEFORE DELETE ON roster_versions
BEGIN SELECT RAISE(ABORT, 'roster versions are append-only'); END;

CREATE TABLE key_bindings (
  member_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL CHECK (length(doc) <= 4096)
);

CREATE TABLE audit_sigs (
  seq INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  roster_version INTEGER NOT NULL CHECK (typeof(roster_version) = 'integer' AND roster_version >= 1),
  epoch INTEGER NOT NULL CHECK (typeof(epoch) = 'integer' AND epoch >= 1),
  sig TEXT NOT NULL CHECK (length(sig) <= 128)
);
