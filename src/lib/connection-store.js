import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * SSH connection profile store — single-file SQLite (.db).
 *
 * Storage layout (inside the plugin dataDir, isolated from ~/.ssh/config):
 *
 *   hrd.db              Single SQLite file. All connection profiles plus
 *                       their encrypted credential entries. This is the
 *                       single source of truth — the .db file itself is the
 *                       external interface: users can open it with any
 *                       SQLite tool and edit the plaintext columns.
 *
 * Schema:
 *   meta(key, value)        schema version marker
 *   profiles(id, alias, host, port, username, key_path, proxy_command,
 *            created_at, updated_at)
 *                           Plaintext connection fields. Users may edit
 *                           these directly with a SQLite tool; the store
 *                           reads live on every call (no cache), so
 *                           external edits take effect immediately.
 *   secrets(profile_id, salt, iv, tag, ciphertext)
 *                           Encrypted credential entries (AES-256-GCM,
 *                           key = scrypt(profileId, salt)). Only the
 *                           plugin reads/writes these — a SQLite tool sees
 *                           opaque BLOBs, so credentials stay secret even
 *                           when the db file is copied or edited.
 *
 * The auth model: credentials are only ever read from the plugin's own
 * encrypted store — the plugin never reads ~/.ssh (isolation boundary).
 * A profile without stored credentials simply cannot authenticate.
 *
 * Transaction model: single-statement writes are atomic in SQLite; the
 * legacy migration runs inside one explicit transaction. busy_timeout
 * arbitrates concurrent access from external editors.
 *
 * Security model:
 *   key = scrypt(profileId, salt). The id lives in plain sight in the
 *   profiles table, so anyone with the whole dataDir can decrypt. This
 *   protects against automated scanners and accidental single-file leaks
 *   (a bare db with only the secrets table carries neither ids nor the
 *   derivation scheme) — it is NOT encryption against an attacker who can
 *   read the entire dataDir.
 *
 *   The whole dataDir can be backed up / synced to another machine and still
 *   decrypts normally (ids and salts travel with the files; nothing is bound
 *   to the machine).
 */

const DB_FILE = "hrd.db";
const SCHEMA_VERSION = "1";

// Legacy v0.2 file names (pre-.db): migrated once, then renamed to .bak.
const LEGACY_CONFIG = "ssh-config";
const LEGACY_INDEX = "secrets.index";
const LEGACY_DATA = "secrets.data";

const SCRYPT_N = 16384; // 2^14 — interactive use

// Per-profile internal id prefix (Hana Remote Dev); machine contract,
// not shown to the user — the user works with Host aliases.
const ID_PREFIX = "HRD_";

// Per-entry fixed crypto header size in the legacy data area:
// salt(16) + iv(12) + tag(16) + dataLen(4)
const LEGACY_ENTRY_HEAD = 48;

// Index magic of the legacy secrets.index file.
const LEGACY_MAGIC = Buffer.from("HRD0", "utf-8");

// ---- Plaintext profile helpers (used for legacy parsing + row mapping) ----

/** Normalize a path for storage: forward slashes keep it portable. */
function toSshPath(p) {
  return String(p ?? "").replace(/\\/g, "/");
}

/** Expand a leading ~ to the home directory. */
function expandTilde(p) {
  if (p === "~") return process.env.USERPROFILE || process.env.HOME || p;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) return path.join(home, p.slice(2));
  }
  return p;
}

/**
 * Parse a legacy OpenSSH-style config string into profile objects.
 * Only used for the one-time migration.
 * @returns {Array<object>} profiles: { name, host, username, port, keyPath,
 * proxyCommand, _directives, _id, _created, _updated }
 */
function parseConfig(raw) {
  const profiles = [];
  let current = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("#")) {
      // Inline metadata comments: "    # hana-id: HRD_xxx" / created / updated
      // (legacy files may write them as plain "# created:" / "# updated:")
      const m = /^#\s*(?:hana-)?(id|created|updated):\s*(.+)$/.exec(trimmed);
      if (m && current) current[`_${m[1]}`] = m[2].trim();
      continue;
    }

    const m = /^([A-Za-z][A-Za-z0-9]*)(?:\s+(.*))?$/.exec(trimmed);
    if (!m) continue;
    const rawKey = m[1];
    const key = rawKey.toLowerCase();
    let value = (m[2] || "").trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }

    if (key === "host") {
      current = {
        name: value,
        host: value,
        username: null,
        port: 22,
        keyPath: null,
        proxyCommand: null,
        _directives: [],
        _id: null,
        _created: null,
        _updated: null,
      };
      profiles.push(current);
    } else if (!current) {
      continue; // directive before any Host block — ignore
    } else if (key === "hostname") {
      current.host = value || current.host;
    } else if (key === "user") {
      current.username = value;
    } else if (key === "port") {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) current.port = n;
    } else if (key === "identityfile") {
      current.keyPath = expandTilde(value);
    } else if (key === "proxycommand") {
      current.proxyCommand = value;
    } else {
      // Any other standard ssh directive: preserved verbatim (original case).
      current._directives.push({ key: rawKey, value });
    }
  }

  return profiles.filter((p) => p.username || p.host);
}

// ---- Legacy secrets index parsing (one-time migration only) ----

/**
 * Parse the legacy secrets.index area into a Map<id, {id, offset, dataLen}>.
 */
function parseLegacyIndex(buf) {
  try {
    if (!buf.subarray(0, 4).equals(LEGACY_MAGIC)) return null;
    let off = 4;
    const count = buf.readUInt16BE(off);
    off += 2;
    const index = new Map();
    for (let i = 0; i < count; i++) {
      const idLen = buf.readUInt16BE(off);
      off += 2;
      if (idLen > 512 || off + idLen + 8 > buf.length) return null;
      const id = buf.subarray(off, off + idLen).toString("utf-8");
      off += idLen;
      const dataLen = buf.readUInt32BE(off);
      off += 4;
      const offset = buf.readUInt32BE(off);
      off += 4;
      index.set(id, { id, offset, dataLen });
    }
    return index;
  } catch {
    return null;
  }
}

/**
 * Read one legacy entry body from secrets.data at its index offset.
 * @returns {{ salt: Buffer, iv: Buffer, tag: Buffer, data: Buffer }|null}
 */
function readLegacyEntry(dataPath, e) {
  try {
    const buf = Buffer.alloc(LEGACY_ENTRY_HEAD + e.dataLen);
    const fd = fs.openSync(dataPath, "r");
    try {
      const n = fs.readSync(fd, buf, 0, buf.length, e.offset);
      if (n !== buf.length) return null;
    } finally {
      fs.closeSync(fd);
    }
    return {
      salt: buf.subarray(0, 16),
      iv: buf.subarray(16, 28),
      tag: buf.subarray(28, 44),
      data: buf.subarray(48),
    };
  } catch {
    return null;
  }
}

// ---- Secret crypto (scrypt-derived AES-256-GCM, system-independent) ----

// Private keys are stored verbatim (PEM, PPK, whatever the format) — the
// ciphertext is opaque anyway, and format-specific munging would only add
// branches and restore risk.

function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
}

/**
 * Encrypt one profile's secrets object.
 * @returns {{ salt: Buffer, iv: Buffer, tag: Buffer, data: Buffer }}
 */
function encryptEntry(obj, secret) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(secret, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(obj), "utf-8");
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { salt, iv, tag: cipher.getAuthTag(), data };
}

/** Decrypt one entry. Returns null on failure (wrong key / corruption). */
function decryptEntry(entry, secret) {
  try {
    const key = deriveKey(secret, entry.salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, entry.iv);
    decipher.setAuthTag(entry.tag);
    const plain = Buffer.concat([decipher.update(entry.data), decipher.final()]);
    const obj = JSON.parse(plain.toString("utf-8"));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/** Map a sqlite row to the public profile shape. */
function rowToProfile(row) {
  return {
    id: row.id,
    alias: row.alias,
    name: row.alias,
    host: row.host,
    port: row.port,
    username: row.username,
    keyPath: row.key_path || null,
    proxyCommand: row.proxy_command || null,
    // Auth method is encrypted with the credentials — not exposed here.
    authMethod: null,
    createdAt: row.created_at,
  };
}

export class ConnectionStore {
  /** @type {string} */
  #dataDir;

  /** @type {DatabaseSync|null} */
  #db = null;

  /** @type {Set<Function>} change listeners (profile create/update/remove) */
  #changeListeners = new Set();

  constructor({ dataDir }) {
    this.#dataDir = dataDir;
  }

  /**
   * Subscribe to profile-store changes (save / update / rename / remove /
   * setSecret). Returns an unsubscribe function.
   * @param {Function} fn
   * @returns {Function}
   */
  onChange(fn) {
    this.#changeListeners.add(fn);
    return () => this.#changeListeners.delete(fn);
  }

  #notifyChange() {
    for (const fn of [...this.#changeListeners]) {
      try {
        fn();
      } catch {
        // a listener must never break the store
      }
    }
  }

  /** Open the db, ensure the schema, migrate legacy files once. */
  async init() {
    fs.mkdirSync(this.#dataDir, { recursive: true });

    const dbPath = path.join(this.#dataDir, DB_FILE);
    const db = new DatabaseSync(dbPath);
    this.#db = db;

    // Single-file constraint: explicit DELETE journal (no -wal/-shm sidecar).
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS profiles (
        id            TEXT PRIMARY KEY,
        alias         TEXT NOT NULL UNIQUE,
        host          TEXT NOT NULL,
        port          INTEGER NOT NULL DEFAULT 22,
        username      TEXT,
        key_path      TEXT,
        proxy_command TEXT,
        created_at    TEXT,
        updated_at    TEXT
      );
      CREATE TABLE IF NOT EXISTS secrets (
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        salt       BLOB NOT NULL,
        iv         BLOB NOT NULL,
        tag        BLOB NOT NULL,
        ciphertext BLOB NOT NULL
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
    `);

    this.#migrateLegacy();
  }

  /** Close the store. */
  close() {
    if (this.#db) {
      try {
        this.#db.close();
      } catch {
        // ignore
      }
      this.#db = null;
    }
  }

  /** List all saved connection profiles (secrets excluded, nothing decrypted). */
  list() {
    const rows = this.#db
      .prepare(`
        SELECT p.*, (s.profile_id IS NOT NULL) AS has_secret
        FROM profiles p
        LEFT JOIN secrets s ON s.profile_id = p.id
        ORDER BY p.alias COLLATE NOCASE
      `)
      .all();
    return rows.map((row) => ({ ...rowToProfile(row), hasSecret: !!row.has_secret }));
  }

  /**
   * Get a single profile by its Host alias (user layer) or internal HRD id
   * (machine layer).
   * @param {string} aliasOrId
   */
  get(aliasOrId) {
    const row = this.#db
      .prepare("SELECT * FROM profiles WHERE alias = ? OR id = ?")
      .get(aliasOrId, aliasOrId);
    return row ? rowToProfile(row) : null;
  }

  /**
   * Add or update a connection profile. Same alias updates in place
   * (ssh config semantics); a new alias creates a new block with a new HRD id.
   * @param {object} profile - { name, host, username, port, keyPath?, proxyCommand? }
   * @returns {object} the saved profile (secrets excluded).
   */
  save(profile) {
    const now = new Date().toISOString();
    const existing = this.get(profile.name);
    if (existing) {
      this.#db
        .prepare(`
          UPDATE profiles
             SET host = ?, port = ?, username = ?, key_path = ?, proxy_command = ?, updated_at = ?
           WHERE id = ?
        `)
        .run(
          profile.host,
          profile.port || 22,
          profile.username ?? null,
          profile.keyPath ?? existing.keyPath ?? null,
          profile.proxyCommand ?? existing.proxyCommand ?? null,
          now,
          existing.id
        );
      return this.get(existing.id);
    }

    const id = this.#genId();
    this.#db
      .prepare(`
        INSERT INTO profiles (id, alias, host, port, username, key_path, proxy_command, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        profile.name,
        profile.host,
        profile.port || 22,
        profile.username ?? null,
        profile.keyPath ?? null,
        profile.proxyCommand ?? null,
        now,
        now
      );
    this.#notifyChange();
    return this.get(id);
  }

  /**
   * Rename a profile's Host alias. The internal HRD id and its encrypted
   * credential entry are preserved — only the alias changes, so secrets
   * stay valid without a rewrite. O(1) on the store.
   * @param {string} aliasOrId - current alias or internal id
   * @param {string} newName - new Host alias
   * @returns {object|null} renamed profile, or null if the target is missing
   * or the new alias is already taken.
   */
  rename(aliasOrId, newName) {
    if (!newName || typeof newName !== "string" || !newName.trim()) return null;
    const target = this.get(aliasOrId);
    if (!target) return null;
    const trimmed = newName.trim();
    if (this.get(trimmed)) return null;

    this.#db
      .prepare("UPDATE profiles SET alias = ?, updated_at = ? WHERE id = ?")
      .run(trimmed, new Date().toISOString(), target.id);
    this.#notifyChange();
    return this.get(target.id);
  }

  /**
   * Update connection fields of a profile in place. The internal HRD id and
   * the encrypted credential entry are preserved. Explicitly passing
   * `proxyCommand: null` (or "") clears the proxy command.
   * @param {string} aliasOrId
   * @param {object} changes - { host?, username?, port?, proxyCommand? }
   * @returns {object|null} updated profile, or null if not found.
   */
  update(aliasOrId, changes) {
    const target = this.get(aliasOrId);
    if (!target || !changes || typeof changes !== "object") return null;

    const sets = [];
    const params = [];
    if (changes.host !== undefined) {
      sets.push("host = ?");
      params.push(String(changes.host));
    }
    if (changes.username !== undefined) {
      sets.push("username = ?");
      params.push(changes.username ? String(changes.username) : null);
    }
    if (changes.port !== undefined) {
      const n = parseInt(changes.port, 10);
      if (!Number.isNaN(n) && n > 0) {
        sets.push("port = ?");
        params.push(n);
      }
    }
    if (changes.proxyCommand !== undefined) {
      sets.push("proxy_command = ?");
      params.push(
        changes.proxyCommand === null || changes.proxyCommand === ""
          ? null
          : String(changes.proxyCommand)
      );
    }
    if (sets.length === 0) return this.get(target.id);

    sets.push("updated_at = ?");
    params.push(new Date().toISOString(), target.id);
    this.#db.prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.#notifyChange();
    return this.get(target.id);
  }

  /** Delete a profile and its secrets (cascade). */
  remove(aliasOrId) {
    const target = this.get(aliasOrId);
    if (!target) return false;
    this.#db.prepare("DELETE FROM profiles WHERE id = ?").run(target.id);
    this.#notifyChange();
    return true;
  }

  // ---- Secret store ----

  /** Get a stored secret field (password / privateKey / passphrase / authMethod) for a profile. */
  getSecret(ref, field) {
    const p = this.get(ref);
    if (!p) return null;
    const row = this.#db
      .prepare("SELECT salt, iv, tag, ciphertext FROM secrets WHERE profile_id = ?")
      .get(p.id);
    if (!row) return null;
    const obj = decryptEntry(
      { salt: Buffer.from(row.salt), iv: Buffer.from(row.iv), tag: Buffer.from(row.tag), data: Buffer.from(row.ciphertext) },
      p.id
    );
    return obj?.[field] || null;
  }

  /**
   * Store a secret field for a profile (encrypted into the db).
   * @returns {boolean} persisted
   */
  setSecret(ref, field, value) {
    if (!value) return true;
    const p = this.get(ref);
    if (!p) return false;

    const prev = this.#decryptAll(p.id) || {};
    const obj = {
      ...prev,
      // One auth method per profile: writing a password clears the key and
      // its passphrase; writing a private key clears the password. Without
      // this, ssh2 would keep preferring a stale password over a new key.
      // (undefined fields are dropped by JSON serialization, so the cleared
      // credential physically disappears from the next encrypted entry.)
      ...(field === "password" ? { privateKey: undefined, passphrase: undefined } : {}),
      ...(field === "privateKey" ? { password: undefined } : {}),
      authMethod: field === "password" ? "password" : field === "privateKey" ? "key" : prev.authMethod || "key",
      [field]: value,
    };
    const entry = encryptEntry(obj, p.id);

    this.#db
      .prepare(`
        INSERT INTO secrets (profile_id, salt, iv, tag, ciphertext)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
          salt = excluded.salt,
          iv = excluded.iv,
          tag = excluded.tag,
          ciphertext = excluded.ciphertext
      `)
      .run(p.id, entry.salt, entry.iv, entry.tag, entry.data);
    this.#notifyChange();
    return true;
  }

  // ---- Internals ----

  /**
   * One-time migration from the legacy v0.2 layout
   * (ssh-config + secrets.index + secrets.data) into hrd.db.
   * Credential ciphertexts are moved byte-for-byte (no re-encryption),
   * so existing credentials keep working after the migration.
   * Legacy files are renamed to .bak only after a successful commit.
   */
  #migrateLegacy() {
    const configPath = path.join(this.#dataDir, LEGACY_CONFIG);
    const indexPath = path.join(this.#dataDir, LEGACY_INDEX);
    const dataPath = path.join(this.#dataDir, LEGACY_DATA);

    const hasConfig = fs.existsSync(configPath);
    const hasSecrets = fs.existsSync(indexPath) && fs.existsSync(dataPath);
    if (!hasConfig && !hasSecrets) return;

    // hrd.db is the authority: if profiles already exist, skip migration.
    const count = this.#db.prepare("SELECT COUNT(*) AS n FROM profiles").get().n;
    if (count > 0) return;

    const now = new Date().toISOString();
    let profiles = [];
    if (hasConfig) {
      profiles = parseConfig(fs.readFileSync(configPath, "utf-8"));
    }

    // Legacy secrets index (id -> { offset, dataLen }).
    let entryIndex = null;
    if (hasSecrets) {
      entryIndex = parseLegacyIndex(fs.readFileSync(indexPath));
    }

    const insertProfile = this.#db.prepare(`
      INSERT INTO profiles (id, alias, host, port, username, key_path, proxy_command, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSecret = this.#db.prepare(`
      INSERT INTO secrets (profile_id, salt, iv, tag, ciphertext)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of profiles) {
        const id = p._id || this.#genId();
        insertProfile.run(
          id,
          p.name,
          p.host,
          p.port || 22,
          p.username ?? null,
          p.keyPath ? toSshPath(p.keyPath) : null,
          p.proxyCommand ?? null,
          // created may be absent in legacy files; fall back to updated,
          // which is closer to the real creation time than "now".
          p._created || p._updated || now,
          p._updated || p._created || now
        );

        if (entryIndex?.has(id)) {
          const entry = readLegacyEntry(dataPath, entryIndex.get(id));
          if (entry) {
            insertSecret.run(id, entry.salt, entry.iv, entry.tag, entry.data);
          }
        }
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    // Commit point passed — only now do legacy files get retired.
    const retire = (p) => {
      try {
        fs.renameSync(p, `${p}.bak`);
      } catch {
        // keep the original if rename fails; it is simply ignored from now on
      }
    };
    if (hasConfig) retire(configPath);
    if (hasSecrets) {
      retire(indexPath);
      retire(dataPath);
    }
  }

  /** Decrypt a profile's full credential object, or null. */
  #decryptAll(id) {
    const row = this.#db
      .prepare("SELECT salt, iv, tag, ciphertext FROM secrets WHERE profile_id = ?")
      .get(id);
    if (!row) return null;
    return decryptEntry(
      { salt: Buffer.from(row.salt), iv: Buffer.from(row.iv), tag: Buffer.from(row.tag), data: Buffer.from(row.ciphertext) },
      id
    );
  }

  /** Generate a fresh per-profile id (HRD prefix; one per config entry). */
  #genId() {
    return `${ID_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
