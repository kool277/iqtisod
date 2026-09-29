ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

UPDATE users SET password_hash = '';

CREATE TABLE user_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc_version INTEGER NOT NULL CHECK (enc_version = 1),
  kdf TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  wrap_iv TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  recovery_salt TEXT,
  recovery_iv TEXT,
  recovery_wrapped_key TEXT,
  meta_iv TEXT NOT NULL,
  meta_ciphertext TEXT NOT NULL CHECK (length(meta_ciphertext) <= 65536),
  created_at TEXT NOT NULL,
  rewrapped_at TEXT NOT NULL,
  CHECK ((recovery_salt IS NULL) = (recovery_iv IS NULL) AND (recovery_iv IS NULL) = (recovery_wrapped_key IS NULL))
);

CREATE TABLE safes (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enc_version INTEGER NOT NULL CHECK (enc_version = 1),
  key_version INTEGER NOT NULL CHECK (typeof(key_version) = 'integer' AND key_version >= 1),
  key_iv TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  meta_iv TEXT NOT NULL,
  meta_ciphertext TEXT NOT NULL CHECK (length(meta_ciphertext) <= 8192),
  deleted_at TEXT,
  UNIQUE (id, owner_user_id)
);
CREATE INDEX idx_safes_owner ON safes(owner_user_id);

CREATE TABLE secure_items (
  id TEXT PRIMARY KEY,
  safe_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  enc_version INTEGER NOT NULL CHECK (enc_version = 1),
  key_version INTEGER NOT NULL CHECK (typeof(key_version) = 'integer' AND key_version >= 1),
  rev INTEGER NOT NULL DEFAULT 1 CHECK (typeof(rev) = 'integer' AND rev >= 1),
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) <= 65536),
  deleted_at TEXT,
  FOREIGN KEY (safe_id, owner_user_id) REFERENCES safes(id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX idx_items_safe ON secure_items(safe_id);
CREATE INDEX idx_items_owner ON secure_items(owner_user_id);

CREATE TABLE safe_events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) <= 4096)
);
CREATE INDEX idx_events_owner ON safe_events(owner_user_id, seq);
