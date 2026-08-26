'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { AppError } = require('./errors.cjs');

/**
 * Key resolution for the two independent 32-byte keys used by the store:
 *   - kind='data'  : encrypts the whole DB (facts, objects, interpretations, relations)
 *   - kind='names' : encrypts data/names.map.enc ONLY (pseudonym <-> real name)
 *
 * Resolution priority (first hit wins):
 *   1. OS keychain   (macOS `security`, Linux `secret-tool`)
 *   2. File          data/<kind>.key  (32 raw bytes, permissions MUST be <= 600)
 *   3. ENV           MACH_KEY / MACH_NAMES_KEY  (base64 or hex, 32 bytes) — last resort
 *
 * Keys are NEVER written to logs. generateKey() prints a one-time base64 backup
 * to STDERR so the operator can stash it in a password manager.
 */

const KEY_LEN = 32;

const KINDS = {
  data: {
    kind: 'data',
    envVar: 'MACH_KEY',
    fileName: 'data.key',
    keychainService: 'machiavelli-data-key',
  },
  names: {
    kind: 'names',
    envVar: 'MACH_NAMES_KEY',
    fileName: 'names.key',
    keychainService: 'machiavelli-names-key',
  },
};

function kindCfg(kind) {
  const cfg = KINDS[kind];
  if (!cfg) {
    throw new AppError('KEY_BAD_KIND', `unknown key kind "${kind}" (expected 'data' | 'names')`);
  }
  return cfg;
}

/** Default data dir: <projectRoot>/data — projectRoot = parent of core/. */
function defaultDataDir() {
  return path.resolve(__dirname, '..', '..', 'data');
}

function keyFilePath(kind, dataDir) {
  return path.join(dataDir || defaultDataDir(), kindCfg(kind).fileName);
}

/** Decode an env-provided key: try base64 then hex, must yield 32 bytes. */
function decodeEnvKey(raw, envVar) {
  const s = String(raw).trim();
  for (const enc of ['base64', 'hex']) {
    try {
      const buf = Buffer.from(s, enc);
      if (buf.length === KEY_LEN) return buf;
    } catch {
      /* try next */
    }
  }
  throw new AppError('KEY_INVALID', `${envVar} must decode (base64 or hex) to exactly ${KEY_LEN} bytes`);
}

// ---- keychain backends -----------------------------------------------------

function keychainGet(service, account) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const val = out.toString('utf8').trim();
      return val || null;
    }
    if (platform === 'linux') {
      const out = execFileSync(
        'secret-tool',
        ['lookup', 'service', service, 'account', account],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const val = out.toString('utf8').trim();
      return val || null;
    }
  } catch {
    // not found / tool missing — treat as absent, fall through to next source
    return null;
  }
  return null;
}

// ---- source detection (no secret material) --------------------------------

/**
 * Which source WOULD provide the key, without revealing it.
 * @param {'data'|'names'} kind
 * @param {{ dataDir?: string }} [opts]
 * @returns {'keychain'|'file'|'env'|null}
 */
function keySource(kind, opts = {}) {
  const cfg = kindCfg(kind);
  if (keychainGet(cfg.keychainService, os.userInfo().username)) return 'keychain';
  const fp = keyFilePath(kind, opts.dataDir);
  if (fs.existsSync(fp)) return 'file';
  if (process.env[cfg.envVar]) return 'env';
  return null;
}

/** Verify a key file is not readable/writable beyond the owner (perm <= 600). */
function assertSafePerms(fp) {
  const st = fs.statSync(fp);
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    throw new AppError(
      'KEY_INSECURE_PERMS',
      `key file ${fp} has mode ${mode.toString(8)}; must be 600 (owner-only). ` +
        `Fix with: chmod 600 "${fp}"`,
      { details: { path: fp, mode: mode.toString(8) } },
    );
  }
}

/**
 * Resolve a 32-byte key for the given kind. Throws KEY_MISSING if none of the
 * sources provide one.
 * @param {'data'|'names'} kind
 * @param {{ dataDir?: string }} [opts]
 * @returns {Buffer}
 */
function resolveKey(kind, opts = {}) {
  const cfg = kindCfg(kind);

  // 1. keychain
  const kc = keychainGet(cfg.keychainService, os.userInfo().username);
  if (kc) return decodeEnvKey(kc, `${cfg.keychainService} (keychain)`);

  // 2. file (perms enforced)
  const fp = keyFilePath(kind, opts.dataDir);
  if (fs.existsSync(fp)) {
    assertSafePerms(fp);
    const buf = fs.readFileSync(fp);
    if (buf.length !== KEY_LEN) {
      throw new AppError('KEY_INVALID', `key file ${fp} must be exactly ${KEY_LEN} raw bytes`, {
        details: { path: fp, len: buf.length },
      });
    }
    return buf;
  }

  // 3. env (last resort)
  const env = process.env[cfg.envVar];
  if (env) return decodeEnvKey(env, cfg.envVar);

  throw new AppError(
    'KEY_MISSING',
    `no ${kind}-key found (checked keychain, ${fp}, and ${cfg.envVar}). ` +
      `Generate one with generateKey('${kind}') or set ${cfg.envVar}.`,
    { details: { kind, envVar: cfg.envVar, file: fp } },
  );
}

/**
 * Generate a fresh 32-byte key, persist it to data/<kind>.key with 600 perms,
 * and print a one-time base64 backup to STDERR. Refuses to overwrite an
 * existing file unless opts.force.
 * @param {'data'|'names'} kind
 * @param {{ dataDir?: string, force?: boolean, persist?: boolean }} [opts]
 * @returns {{ key: Buffer, path: string|null, backupBase64: string }}
 */
function generateKey(kind, opts = {}) {
  kindCfg(kind);
  const key = crypto.randomBytes(KEY_LEN);
  const backupBase64 = key.toString('base64');
  const persist = opts.persist !== false;

  let fp = null;
  if (persist) {
    const dir = opts.dataDir || defaultDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fp = keyFilePath(kind, opts.dataDir);
    if (fs.existsSync(fp) && !opts.force) {
      throw new AppError('KEY_EXISTS', `key file already exists: ${fp} (pass force to overwrite)`, {
        details: { path: fp },
      });
    }
    // write with restrictive mode then hard-enforce chmod (umask-proof)
    fs.writeFileSync(fp, key, { mode: 0o600 });
    fs.chmodSync(fp, 0o600);
  }

  process.stderr.write(
    `\n[machiavelli] Generated new ${kind}-key.\n` +
      `  BACKUP (base64, store in a password manager, shown ONCE):\n` +
      `    ${backupBase64}\n` +
      (fp ? `  Saved to: ${fp} (chmod 600)\n\n` : `  (not persisted)\n\n`),
  );

  return { key, path: fp, backupBase64 };
}

/**
 * Export the current key for a given kind as a hex string.
 * Prints a WARNING to stderr — this is for backup/migration only.
 * @param {'data'|'names'} kind
 * @param {{ dataDir?: string }} [opts]
 * @returns {{ kind: string, keyHex: string }}
 */
function exportKey(kind, opts = {}) {
  const key = resolveKey(kind, opts);
  const keyHex = key.toString('hex');
  process.stderr.write(
    `\n[machiavelli] WARNING: Exporting ${kind}-key in plaintext hex.\n` +
      `  Store this securely and NEVER commit it to version control.\n` +
      `  Use only for backup or migration to a new machine.\n\n`,
  );
  return { kind, keyHex };
}

/**
 * Import a key from a 64-char hex string, persisting it to data/<kind>.key.
 * Validates length (must be 32 bytes = 64 hex chars). Refuses to overwrite
 * existing key file unless opts.force is true.
 * @param {'data'|'names'} kind
 * @param {string} keyHex
 * @param {{ dataDir?: string, force?: boolean }} [opts]
 * @returns {{ kind: string, path: string }}
 */
function importKey(kind, keyHex, opts = {}) {
  kindCfg(kind);
  const s = String(keyHex || '').trim();
  let key;
  try {
    key = Buffer.from(s, 'hex');
  } catch {
    throw new AppError('KEY_INVALID', 'keyHex must be a valid hex string');
  }
  if (key.length !== KEY_LEN) {
    throw new AppError(
      'KEY_INVALID',
      `imported key must be exactly ${KEY_LEN} bytes (${KEY_LEN * 2} hex chars), got ${key.length}`,
    );
  }

  const dir = opts.dataDir || defaultDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const fp = keyFilePath(kind, opts.dataDir);
  if (fs.existsSync(fp) && !opts.force) {
    throw new AppError(
      'KEY_EXISTS',
      `key file already exists: ${fp} (pass force:true to overwrite)`,
      { details: { path: fp } },
    );
  }
  fs.writeFileSync(fp, key, { mode: 0o600 });
  fs.chmodSync(fp, 0o600);

  process.stderr.write(
    `\n[machiavelli] Imported ${kind}-key to ${fp} (chmod 600).\n\n`,
  );
  return { kind, path: fp };
}

module.exports = {
  resolveKey,
  generateKey,
  exportKey,
  importKey,
  keySource,
  keyFilePath,
  defaultDataDir,
  KEY_LEN,
};
