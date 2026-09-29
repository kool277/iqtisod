CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('INVITE', 'RESET')),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER REFERENCES roles(id),
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  code_verifier TEXT NOT NULL,
  stop_old_password INTEGER NOT NULL DEFAULT 0 CHECK (stop_old_password IN (0, 1)),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT CHECK (ended_reason IN ('USED', 'REVOKED', 'EXPIRED', 'REPLACED')),
  ended_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK ((kind = 'INVITE' AND role_id IS NOT NULL) OR (kind = 'RESET' AND user_id IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);
CREATE UNIQUE INDEX idx_grants_open_email ON access_grants(email) WHERE ended_at IS NULL;
CREATE INDEX idx_grants_expiry ON access_grants(expires_at);

CREATE TABLE user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc_version INTEGER NOT NULL CHECK (enc_version = 1),
  kdf TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL CHECK (length(secret_ciphertext) <= 1024),
  last_step INTEGER NOT NULL DEFAULT 0 CHECK (typeof(last_step) = 'integer' AND last_step >= 0),
  recovery_salt TEXT NOT NULL,
  recovery_hashes TEXT NOT NULL CHECK (length(recovery_hashes) <= 2048),
  created_at TEXT NOT NULL,
  rewrapped_at TEXT NOT NULL
);
