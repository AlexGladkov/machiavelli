'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./errors.cjs');

/**
 * SQLite facade over two drivers:
 *   - node:sqlite     (built-in, primary when Node >= 22.5)
 *   - better-sqlite3  (optional dependency, fallback)
 *
 * Facade shape (driver-agnostic):
 *   {
 *     prepare(sql)           -> Statement { get(...p), all(...p), run(...p) }
 *     exec(sql)              -> void        (multi-statement DDL)
 *     transaction(fn)        -> (...args) => result   (runs fn in BEGIN/COMMIT)
 *     pragma(str)            -> void
 *     close()                -> void
 *     driver                 -> 'node:sqlite' | 'better-sqlite3'
 *     raw                    -> underlying handle (escape hatch)
 *   }
 *
 * PRAGMAs applied on open: journal_mode=WAL, foreign_keys=ON, busy_timeout=5000.
 */

/**
 * @param {{ cipher?: 'field'|'sqlcipher' }} [opts]
 * @returns {'node:sqlite'|'better-sqlite3'|'sqlcipher'|null}
 *
 * MACH_CIPHER=sqlcipher (or config.cipher='sqlcipher') opts in to the SQLCipher
 * backend via better-sqlite3-multiple-ciphers. The package is present in
 * core/node_modules and works on Node 26. It is NOT the default because:
 *   1. node:sqlite (built-in) is faster and zero-dep for normal field-level encryption.
 *   2. SQLCipher adds a dependency on native binaries that can break on Node major bumps.
 * Field-level AES-256-GCM (default) provides equivalent security for individual columns
 * and is the recommended mode.
 */
function detectDriver(opts = {}) {
  // Explicit SQLCipher opt-in.
  const cipher = opts.cipher || process.env.MACH_CIPHER || 'field';
  if (cipher === 'sqlcipher') {
    try {
      require.resolve('better-sqlite3-multiple-ciphers');
      return 'sqlcipher';
    } catch {
      // Not installed in the current require path — fall through to default.
    }
  }

  // Prefer the built-in when available.
  try {
    // Node >= 22.5 ships node:sqlite (behind a flag on 22.x, stable on 24+).
    require('node:sqlite');
    return 'node:sqlite';
  } catch {
    /* not available -> try fallback */
  }
  try {
    require.resolve('better-sqlite3');
    return 'better-sqlite3';
  } catch {
    return null;
  }
}

/** Walk up from a path looking for a .git dir; returns repo root or null. */
function findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---- driver adapters -------------------------------------------------------

function openNodeSqlite(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const handle = new DatabaseSync(dbPath);

  const facade = {
    driver: 'node:sqlite',
    raw: handle,
    prepare(sql) {
      const stmt = handle.prepare(sql);
      return {
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
        run: (...params) => {
          const r = stmt.run(...params);
          return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
        },
      };
    },
    exec(sql) {
      handle.exec(sql);
    },
    pragma(str) {
      handle.exec(`PRAGMA ${str};`);
    },
    transaction(fn) {
      return (...args) => {
        handle.exec('BEGIN');
        try {
          const out = fn(...args);
          handle.exec('COMMIT');
          return out;
        } catch (err) {
          try {
            handle.exec('ROLLBACK');
          } catch {
            /* ignore rollback failure */
          }
          throw err;
        }
      };
    },
    close() {
      handle.close();
    },
  };
  return facade;
}

function openBetterSqlite(dbPath) {
  const Database = require('better-sqlite3');
  const handle = new Database(dbPath);

  const facade = {
    driver: 'better-sqlite3',
    raw: handle,
    prepare(sql) {
      const stmt = handle.prepare(sql);
      return {
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
        run: (...params) => {
          const r = stmt.run(...params);
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
      };
    },
    exec(sql) {
      handle.exec(sql);
    },
    pragma(str) {
      handle.pragma(str);
    },
    transaction(fn) {
      // better-sqlite3 has native transaction() but we keep a uniform wrapper.
      const wrapped = handle.transaction((...args) => fn(...args));
      return (...args) => wrapped(...args);
    },
    close() {
      handle.close();
    },
  };
  return facade;
}

/**
 * Open via better-sqlite3-multiple-ciphers with PRAGMA key applied.
 * sqlcipherKey is the DB-level encryption key (separate from the field-level dataKey).
 * This is an OPT-IN mode (MACH_CIPHER=sqlcipher). Default mode is field-level AES-GCM.
 */
function openSqlCipher(dbPath, sqlcipherKey) {
  const Database = require('better-sqlite3-multiple-ciphers');
  const handle = new Database(dbPath);
  // Apply DB-level encryption. Key can be a passphrase or raw bytes.
  if (sqlcipherKey) {
    handle.pragma(`key='${String(sqlcipherKey).replace(/'/g, "''")}'`);
  }

  const facade = {
    driver: 'sqlcipher',
    raw: handle,
    prepare(sql) {
      const stmt = handle.prepare(sql);
      return {
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
        run: (...params) => {
          const r = stmt.run(...params);
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
      };
    },
    exec(sql) {
      handle.exec(sql);
    },
    pragma(str) {
      handle.pragma(str);
    },
    transaction(fn) {
      const wrapped = handle.transaction((...args) => fn(...args));
      return (...args) => wrapped(...args);
    },
    close() {
      handle.close();
    },
  };
  return facade;
}

// ---- migrations ------------------------------------------------------------

/**
 * Ordered migration list. Each entry is applied inside its own transaction and
 * bumps PRAGMA user_version to its index+1. Never renumber / mutate applied ones.
 *
 * Schema follows spec §5 with the agreed amendments:
 *   - relations.rel_enc : encrypted relation type (origin/status/ts stay plaintext for indexing)
 *   - meta(key,value)   : consent_given / contract_version / pseudonym_ready
 *   - objects.alias     : optional human alias alongside encrypted name
 *   - facts.tombstoned  : soft-delete flag (append-only; never hard delete)
 *   - facts.dedup_hash  : subject + normalized-body hash for dedup
 */
const MIGRATIONS = [
  // v1: base schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL CHECK (kind IN ('person','place','document','event')),
        code          TEXT UNIQUE,            -- pseudo-code, e.g. person_7f3a91cc
        alias         TEXT,                   -- optional plaintext human alias
        name_enc      BLOB,                   -- AES-GCM(name)      aad=objects.name_enc
        props_json_enc BLOB,                  -- AES-GCM(props)     aad=objects.props_json_enc
        is_ego        INTEGER NOT NULL DEFAULT 0,
        created_ts    INTEGER NOT NULL,
        updated_ts    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_objects_kind ON objects(kind);
      -- at most one ego row
      CREATE UNIQUE INDEX IF NOT EXISTS idx_objects_single_ego
        ON objects(is_ego) WHERE is_ego = 1;

      CREATE TABLE IF NOT EXISTS facts (
        id           TEXT PRIMARY KEY,
        subject_id   TEXT NOT NULL REFERENCES objects(id),
        body_enc     BLOB NOT NULL,           -- AES-GCM(body)  aad=facts.body_enc
        source       TEXT,
        confidence   TEXT,
        dedup_hash   TEXT NOT NULL,           -- sha256(subject_id + normalized body)
        tombstoned   INTEGER NOT NULL DEFAULT 0,
        created_ts   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_dedup
        ON facts(subject_id, dedup_hash) WHERE tombstoned = 0;

      CREATE TABLE IF NOT EXISTS interpretations (
        id                   TEXT PRIMARY KEY,
        subject_id           TEXT NOT NULL REFERENCES objects(id),
        lens                 TEXT NOT NULL,
        body_enc             BLOB NOT NULL,   -- AES-GCM(body)  aad=interpretations.body_enc
        model                TEXT,
        based_on_fact_ids_json TEXT,
        is_current           INTEGER NOT NULL DEFAULT 1,
        created_ts           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interp_subject_lens ON interpretations(subject_id, lens);
      CREATE INDEX IF NOT EXISTS idx_interp_current
        ON interpretations(subject_id, lens, is_current);

      CREATE TABLE IF NOT EXISTS relations (
        id         TEXT PRIMARY KEY,
        from_id    TEXT NOT NULL REFERENCES objects(id),
        to_id      TEXT NOT NULL REFERENCES objects(id),
        rel_enc    BLOB NOT NULL,             -- AES-GCM(rel)  aad=relations.rel_enc
        origin     TEXT NOT NULL CHECK (origin IN ('fact','interp')),
        status     TEXT NOT NULL CHECK (status IN ('confirmed','pending')),
        created_ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_id);
      CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_id);
      CREATE INDEX IF NOT EXISTS idx_rel_status ON relations(status);

      CREATE TABLE IF NOT EXISTS actions (
        id            TEXT PRIMARY KEY,
        verb          TEXT NOT NULL,
        target_id     TEXT REFERENCES objects(id),
        payload_json_enc BLOB,
        ts            INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS guard_audit (
        id       TEXT PRIMARY KEY,
        command  TEXT,
        verdict  TEXT CHECK (verdict IN ('block','rewrite','pass')),
        reason   TEXT,
        ts       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  },
];

/**
 * Apply pending migrations based on PRAGMA user_version. Each migration runs in
 * its own transaction; user_version is bumped only on success.
 * @param {object} db facade
 * @returns {{ from: number, to: number, applied: number }}
 */
function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  // node:sqlite returns { user_version: n }; normalise.
  const from = Number(row && (row.user_version ?? Object.values(row)[0])) || 0;
  let current = from;

  for (let i = from; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    const runMigration = db.transaction(() => {
      MIGRATIONS[i](db);
      // PRAGMA can't be parameterised; version is a controlled integer.
      db.exec(`PRAGMA user_version = ${version};`);
    });
    try {
      runMigration();
    } catch (err) {
      throw new AppError('STORE_MIGRATE_FAILED', `migration to v${version} failed: ${err.message}`, {
        cause: err,
        details: { version },
      });
    }
    current = version;
  }
  return { from, to: current, applied: current - from };
}

/**
 * Open (creating if needed) the store, apply PRAGMAs + migrations, and return
 * the facade with the dataKey attached for downstream modules.
 *
 * @param {{ dbPath: string, dataKey: Buffer, allowInRepo?: boolean,
 *           cipher?: 'field'|'sqlcipher', sqlcipherKey?: string }} opts
 * @returns {object} facade with extra { dataKey } field
 *
 * cipher='field' (default): standard SQLite + AES-256-GCM field-level encryption.
 * cipher='sqlcipher': SQLCipher DB-level encryption via better-sqlite3-multiple-ciphers
 *   (opt-in via MACH_CIPHER=sqlcipher or config.cipher='sqlcipher'). Field-level
 *   encryption still applies on top for defence-in-depth when sqlcipherKey is also set.
 *   Note: sqlcipherKey is the DB passphrase, dataKey is the field-level key — they are
 *   independent. If only sqlcipherKey is needed, pass a dummy dataKey.
 */
function openStore(opts = {}) {
  const { dbPath, dataKey } = opts;
  if (!dbPath) throw new AppError('STORE_BAD_ARGS', 'openStore requires { dbPath }');
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) {
    throw new AppError('STORE_BAD_ARGS', 'openStore requires a 32-byte dataKey Buffer');
  }

  const cipher = opts.cipher || process.env.MACH_CIPHER || 'field';
  const driver = detectDriver({ cipher });
  if (!driver) {
    throw new AppError(
      'NO_SQLITE',
      'No usable SQLite driver. Use Node >= 22.5 (built-in node:sqlite) or run: ' +
        'npm install --prefix core better-sqlite3',
      { retryable: false },
    );
  }

  // Warn (do not block) if the DB lives inside a git repo — risk of committing PII.
  const dir = path.dirname(path.resolve(dbPath));
  fs.mkdirSync(dir, { recursive: true });
  const gitRoot = findGitRoot(dir);
  if (gitRoot && !opts.allowInRepo) {
    process.stderr.write(
      `[machiavelli] WARNING: db path is inside a git repo (${gitRoot}).\n` +
        `  Ensure data/ , *.db , *.enc are git-ignored to avoid committing PII.\n`,
    );
  }

  let db;
  try {
    if (driver === 'sqlcipher') {
      db = openSqlCipher(dbPath, opts.sqlcipherKey);
    } else if (driver === 'node:sqlite') {
      db = openNodeSqlite(dbPath);
    } else {
      db = openBetterSqlite(dbPath);
    }
  } catch (err) {
    throw new AppError('STORE_OPEN_FAILED', `failed to open db at ${dbPath}: ${err.message}`, {
      cause: err,
      details: { dbPath, driver },
    });
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    throw new AppError('STORE_PRAGMA_FAILED', `failed to set pragmas: ${err.message}`, { cause: err });
  }

  migrate(db);

  db.dataKey = dataKey;
  db.dbPath = dbPath;
  return db;
}

module.exports = {
  openStore,
  detectDriver,
  migrate,
  findGitRoot,
  MIGRATIONS,
};
