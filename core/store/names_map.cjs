'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encrypt, decrypt, newPseudoCode } = require('./crypto.cjs');
const { AppError } = require('./errors.cjs');

/**
 * Pseudonym map — the ONLY place real names live, encrypted under a SEPARATE
 * names-key (distinct from the DB data-key). Stored as a single encrypted blob
 * at data/names.map.enc.
 *
 * On-disk file layout: exactly the crypto.encrypt() GCM blob whose plaintext is
 * a JSON object { "<code>": "<real name>", ... }. AAD = "names.map".
 *
 * Writes are atomic (temp file -> fsync -> rename) to avoid half-written maps.
 * GCM auth tag guarantees integrity / tamper detection on read.
 */

const MAP_AAD = 'names.map';

function defaultMapPath() {
  return path.resolve(__dirname, '..', '..', 'data', 'names.map.enc');
}

/**
 * Load and decrypt the map. Returns {} if the file does not exist yet.
 * @param {Buffer} namesKey
 * @param {string} [mapPath]
 * @returns {Record<string,string>}
 */
function loadMap(namesKey, mapPath) {
  const fp = mapPath || defaultMapPath();
  if (!fs.existsSync(fp)) return {};
  let blob;
  try {
    blob = fs.readFileSync(fp);
  } catch (err) {
    throw new AppError('NAMES_READ_FAILED', `cannot read names map ${fp}: ${err.message}`, { cause: err });
  }
  let json;
  try {
    json = decrypt(blob, namesKey, MAP_AAD);
  } catch (err) {
    throw new AppError('NAMES_DECRYPT_FAILED', `names map integrity/decrypt failure: ${err.message}`, {
      cause: err,
      details: { path: fp },
    });
  }
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new AppError('NAMES_CORRUPT', `names map JSON is corrupt: ${err.message}`, { cause: err });
  }
}

/**
 * Encrypt and atomically persist the map.
 * @param {Record<string,string>} map
 * @param {Buffer} namesKey
 * @param {string} [mapPath]
 */
function saveMap(map, namesKey, mapPath) {
  const fp = mapPath || defaultMapPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const blob = encrypt(JSON.stringify(map), namesKey, MAP_AAD);

  const tmp = `${fp}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, blob);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, fp); // atomic on same filesystem
}

/**
 * Return the pseudo-code for a real name, creating (and persisting) a new one
 * if the name is not yet mapped. Reverse lookup is exact-match on the name.
 * @param {string} name
 * @param {Buffer} namesKey
 * @param {{ mapPath?: string, prefix?: string }} [opts]
 * @returns {string} code, e.g. person_7f3a91cc
 */
function codeFor(name, namesKey, opts = {}) {
  if (!name || String(name).trim() === '') {
    throw new AppError('STORE_BAD_ARGS', 'codeFor requires a non-empty name');
  }
  const map = loadMap(namesKey, opts.mapPath);
  for (const [code, real] of Object.entries(map)) {
    if (real === name) return code;
  }
  let code;
  do {
    code = newPseudoCode(opts.prefix || 'person');
  } while (map[code]);
  map[code] = String(name);
  saveMap(map, namesKey, opts.mapPath);
  return code;
}

/**
 * Resolve a pseudo-code back to the real name, or null if unknown.
 * @param {string} code
 * @param {Buffer} namesKey
 * @param {{ mapPath?: string }} [opts]
 * @returns {string|null}
 */
function resolve(code, namesKey, opts = {}) {
  const map = loadMap(namesKey, opts.mapPath);
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : null;
}

module.exports = {
  codeFor,
  resolve,
  loadMap,
  saveMap,
  defaultMapPath,
};
