import{p as e}from"./react-IPCXuqHG.js";import{C as t,b as n,s as r,x as i}from"./money-Dyn0G6Ok.js";import{o as a,s as o}from"./rbac-Mji8LhVS.js";import{t as s}from"./limits-D80KQV2n.js";var c={version:`1.6.0`,commit:`543b0cf053c2`,builtAt:`2026-10-02T02:36:16.000Z`},l=c.version,u=s.sqliteValueBytes,d=null;function f(){return d??=e(()=>import(`./dist-BFwFu0tq.js`).then(e=>e.default()),[],import.meta.url),d.catch(()=>{d=null}),d}function p(e){return typeof e==`bigint`?Number(e):typeof e==`number`||typeof e==`string`?e:null}function m(e){let t={};for(let[n,r]of Object.entries(e))t[n]=p(r);return t}function h(e,t,n=0){let{capi:r}=e,i=t.pointer;if(i==null)throw Error(`SQLite handle is not open`);t.checkRc(r.sqlite3_db_config(i,r.SQLITE_DBCONFIG_DEFENSIVE,1,0)),t.checkRc(r.sqlite3_db_config(i,r.SQLITE_DBCONFIG_TRUSTED_SCHEMA,0,0)),r.sqlite3_limit(i,r.SQLITE_LIMIT_LENGTH,u),r.sqlite3_limit(i,r.SQLITE_LIMIT_ATTACHED,n),t.exec(`PRAGMA trusted_schema = OFF`),t.exec(`PRAGMA cell_size_check = ON`)}var g=class e{sqlite3;db;constructor(e,t){this.sqlite3=e,this.db=t}static async openEmpty(){let t=await f(),n=new t.oo1.DB(`:memory:`,`c`),r=new e(t,n);return r.configure(),r}configure(){h(this.sqlite3,this.db),this.exec(`PRAGMA foreign_keys = ON`),this.exec(`PRAGMA secure_delete = ON`)}vacuum(){let{capi:e}=this.sqlite3,t=this.db.pointer;if(t==null)throw Error(`SQLite handle is not open`);e.sqlite3_limit(t,e.SQLITE_LIMIT_ATTACHED,1);try{this.exec(`VACUUM`)}finally{e.sqlite3_limit(t,e.SQLITE_LIMIT_ATTACHED,0)}}sizeBytes(){return Number(this.queryValue(`PRAGMA page_count`)??0)*Number(this.queryValue(`PRAGMA page_size`)??0)}static async openBytes(t){let n=await f(),r=new n.oo1.DB(`:memory:`,`c`);if(r.pointer==null)throw Error(`SQLite handle is not open`);let i=new Uint8Array(t.byteLength);i.set(t);let a;try{a=n.wasm.allocFromTypedArray(i)}finally{i.fill(0)}let o=n.capi.SQLITE_DESERIALIZE_FREEONCLOSE|n.capi.SQLITE_DESERIALIZE_RESIZEABLE,s=n.capi.sqlite3_deserialize(r.pointer,`main`,a,i.byteLength,i.byteLength,o);r.checkRc(s);let c=new e(n,r);return c.configure(),c}exec(e,t=[]){t.length===0?this.db.exec(e):this.db.exec(e,{bind:t})}query(e,t=[]){return(t.length===0?this.db.selectObjects(e):this.db.selectObjects(e,t)).map(e=>m(e))}queryOne(e,t=[]){let n=t.length===0?this.db.selectObject(e):this.db.selectObject(e,t);return n?m(n):null}queryValue(e,t=[]){let n=t.length===0?this.db.selectValue(e):this.db.selectValue(e,t);if(n!==void 0)return p(n)}withTransaction(e){this.exec(`BEGIN`);try{let t=e();return this.exec(`COMMIT`),t}catch(e){try{this.exec(`ROLLBACK`)}catch{}throw e}}export(){if(this.db.pointer==null)throw Error(`SQLite handle is not open`);let e=this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer);return e instanceof Uint8Array?e:new Uint8Array(e)}close(){this.db.close()}},_=`PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  permissions TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role_id INTEGER NOT NULL,
  group_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_uz_latn TEXT NOT NULL,
  name_uz_cyrl TEXT NOT NULL,
  name_ru TEXT NOT NULL,
  type TEXT CHECK(type IN ('INCOME', 'EXPENSE')) NOT NULL,
  icon TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT CHECK(type IN ('INCOME', 'EXPENSE')) NOT NULL,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  category_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  transaction_date DATE NOT NULL,
  notes TEXT,
  receipt_data TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_group ON transactions(group_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,v={USD:2,UZS:2,EUR:2,RUB:2};function y(e){return e==null?null:String(e)}function b(e){e.exec(`CREATE TABLE currencies (
    code TEXT PRIMARY KEY CHECK (length(code) = 3 AND code = upper(code)),
    minor_unit INTEGER NOT NULL CHECK (typeof(minor_unit) = 'integer' AND minor_unit BETWEEN 0 AND 4)
  )`);for(let[t,n]of Object.entries(v))e.exec(`INSERT INTO currencies (code, minor_unit) VALUES (?, ?)`,[t,n])}function x(e){e.exec(`CREATE TABLE transactions_v2 (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('INCOME', 'EXPENSE')),
    amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
    currency TEXT NOT NULL REFERENCES currencies(code),
    category_id INTEGER NOT NULL REFERENCES categories(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    group_id INTEGER NOT NULL REFERENCES groups(id),
    transaction_date TEXT NOT NULL CHECK (transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
    notes TEXT,
    receipt_data TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);let t=e.query(`SELECT id, type, amount, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data,
            COALESCE(created_at, CURRENT_TIMESTAMP) AS created_at, COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) AS updated_at
     FROM transactions ORDER BY rowid`);for(let n of t){let t=n.currency==null?`USD`:String(n.currency),i=v[t];if(i===void 0)throw Error(`transaction ${n.id} uses unknown currency ${t}`);let a=r(Number(n.amount),i);if(a<=0)throw Error(`transaction ${n.id} has a non-positive amount`);e.exec(`INSERT INTO transactions_v2 (
         id, type, amount_minor, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,[n.id,n.type,a,t,n.category_id,n.user_id,n.group_id,n.transaction_date,n.notes,n.receipt_data,n.created_at,n.updated_at])}e.exec(`DROP TABLE transactions`),e.exec(`ALTER TABLE transactions_v2 RENAME TO transactions`),e.exec(`CREATE INDEX idx_tx_date ON transactions(transaction_date);
    CREATE INDEX idx_tx_user ON transactions(user_id);
    CREATE INDEX idx_tx_group ON transactions(group_id);
    CREATE INDEX idx_tx_currency_date ON transactions(currency, transaction_date);`)}function S(e){e.exec(`CREATE TABLE audit_logs_v2 (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    actor_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL,
    prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
    hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64)
  )`);let t=e.query(`SELECT id, actor_id, action, entity_type, entity_id, details, COALESCE(created_at, CURRENT_TIMESTAMP) AS created_at
     FROM audit_logs ORDER BY rowid`),n=a;t.forEach((t,r)=>{let i={seq:r+1,id:String(t.id),actorId:y(t.actor_id),action:String(t.action),entityType:y(t.entity_type),entityId:y(t.entity_id),details:y(t.details),createdAt:String(t.created_at),prevHash:n},a=o(i);e.exec(`INSERT INTO audit_logs_v2 (seq, id, actor_id, action, entity_type, entity_id, details, created_at, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,[i.seq,i.id,i.actorId,i.action,i.entityType,i.entityId,i.details,i.createdAt,i.prevHash,a]),n=a}),e.exec(`DROP TABLE audit_logs`),e.exec(`ALTER TABLE audit_logs_v2 RENAME TO audit_logs`),e.exec(`CREATE INDEX idx_audit_created ON audit_logs(created_at);
    CREATE TRIGGER audit_logs_append_only_update BEFORE UPDATE ON audit_logs
    BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
    CREATE TRIGGER audit_logs_append_only_delete BEFORE DELETE ON audit_logs
    BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;`)}function C(e){b(e),x(e),S(e),e.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT,
    app_version TEXT
  )`),e.exec(`INSERT INTO schema_migrations (version, name, applied_at, app_version) VALUES (1, 'baseline', NULL, NULL)`)}var w=`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
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
`,T=`CREATE TABLE access_grants (
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
`,E=[{version:1,name:`baseline`,up:e=>e.exec(_)},{version:2,name:`exact-money-and-audit-chain`,up:C},{version:3,name:`private-safes-and-verifier`,up:e=>e.exec(w)},{version:4,name:`access-grants-and-sign-in-check`,up:e=>e.exec(T)}];function D(e,t){return Number(e.queryValue(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`,[t])??0)>0}function O(e){let t=Number(e.queryValue(`PRAGMA user_version`)??0);return t>0?t:+!!D(e,`transactions`)}function k(e,t){let n=e.queryValue(`PRAGMA quick_check`);if(n!==`ok`)throw new i(t,`quick_check: ${String(n)}`)}function A(e,t){let r=t.migrations??E,a=r.length>0?r[r.length-1].version:0,o=O(e);if(o>a)throw new n;let s=r.filter(e=>e.version>o);if(s.length===0)return k(e,a),{from:o,to:o,applied:[]};let c=t.now??new Date().toISOString();e.exec(`PRAGMA foreign_keys = OFF`);try{for(let n of s)try{e.withTransaction(()=>{n.up(e);let r=e.query(`PRAGMA foreign_key_check`);if(r.length>0)throw Error(`${r.length} foreign key violations`);e.exec(`PRAGMA user_version = ${n.version}`),D(e,`schema_migrations`)&&e.exec(`INSERT OR REPLACE INTO schema_migrations (version, name, applied_at, app_version) VALUES (?, ?, ?, ?)`,[n.version,n.name,c,t.appVersion])})}catch(e){throw new i(n.version,e instanceof Error?e.message:String(e))}}finally{e.exec(`PRAGMA foreign_keys = ON`)}return k(e,a),{from:o,to:a,applied:s.map(e=>e.version)}}var j=new Map;function M(e){let t=e.query(`SELECT type, name, tbl_name, sql FROM sqlite_master`);return new Map(t.map(e=>[`${String(e.type)}:${String(e.name)}:${String(e.tbl_name)}`,e.sql==null?null:String(e.sql).replace(/\s+/g,` `).trim()]))}function N(e){let t=j.get(e);return t||(t=g.openEmpty().then(t=>{try{return A(t,{appVersion:`schema-check`,migrations:E.slice(0,e)}),M(t)}finally{t.close()}}),t.catch(()=>j.delete(e)),j.set(e,t)),t}async function P(e,n=O(e)){if(!Number.isSafeInteger(n)||n<1||n>4)throw new t(`SCHEMA_UNKNOWN`);let r=await N(n),i=M(e);if(i.size!==r.size)throw new t(`SCHEMA_UNKNOWN`);for(let[e,n]of i)if(!r.has(e)||r.get(e)!==n)throw new t(`SCHEMA_UNKNOWN`)}function F(e,t){let n=e.queryValue(`SELECT value FROM settings WHERE key = ?`,[t]);return n==null?null:String(n)}function I(e,t,n){e.exec(`INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,[t,n])}export{O as a,f as c,A as i,l,I as n,g as o,P as r,h as s,F as t,c as u};