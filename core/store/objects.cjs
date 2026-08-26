'use strict';

const crypto = require('node:crypto');
const { encrypt, decrypt, newPseudoCode } = require('./crypto.cjs');
const { AppError } = require('./errors.cjs');

/**
 * Objects layer — people/places/documents/events with encrypted name + props.
 * `name` and `props` are encrypted with the data-key; `code` (pseudo-code),
 * `alias`, `kind`, `is_ego`, timestamps stay plaintext for lookup/indexing.
 */

const NAME_AAD = 'objects.name_enc';
const PROPS_AAD = 'objects.props_json_enc';
const VALID_KINDS = ['person', 'place', 'document', 'event'];

function now() {
  return Date.now();
}

function encName(db, name) {
  return name == null ? null : encrypt(String(name), db.dataKey, NAME_AAD);
}
function encProps(db, props) {
  const json = JSON.stringify(props == null ? {} : props);
  return encrypt(json, db.dataKey, PROPS_AAD);
}

/** Decode a raw DB row into a plaintext object (decrypting name/props). */
function decodeRow(db, row) {
  if (!row) return null;
  let name = null;
  let props = {};
  try {
    if (row.name_enc) name = decrypt(toBuf(row.name_enc), db.dataKey, NAME_AAD);
    if (row.props_json_enc) props = JSON.parse(decrypt(toBuf(row.props_json_enc), db.dataKey, PROPS_AAD));
  } catch (err) {
    throw new AppError('DECRYPT_FAILED', `failed to decrypt object ${row.id}: ${err.message}`, {
      cause: err,
      details: { id: row.id },
    });
  }
  return {
    id: row.id,
    kind: row.kind,
    code: row.code,
    alias: row.alias,
    name,
    props,
    is_ego: !!row.is_ego,
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
  };
}

/** node:sqlite returns BLOBs as Uint8Array; normalise to Buffer. */
function toBuf(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

/**
 * Create the single ego (is_ego=1) object. Throws if one already exists.
 * @param {object} db
 * @param {{ name?: string, alias?: string, props?: object }} [info]
 * @returns {object} decoded ego object
 */
function createEgo(db, info = {}) {
  const existing = getEgo(db);
  if (existing) {
    throw new AppError('STORE_EGO_EXISTS', 'ego object already exists (only one is_ego=1 allowed)', {
      details: { id: existing.id },
    });
  }
  const id = crypto.randomUUID();
  const ts = now();
  const code = newPseudoCode('ego');
  db.prepare(
    `INSERT INTO objects (id, kind, code, alias, name_enc, props_json_enc, is_ego, created_ts, updated_ts)
     VALUES (?, 'person', ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, code, info.alias ?? null, encName(db, info.name ?? 'Me'), encProps(db, info.props), ts, ts);
  return getById(db, id);
}

/**
 * Create a non-ego object.
 * @param {object} db
 * @param {'person'|'place'|'document'|'event'} kind
 * @param {string} name
 * @param {object} [props]
 * @param {{ alias?: string }} [opts]
 * @returns {object} decoded object
 */
function createObject(db, kind, name, props = {}, opts = {}) {
  if (!VALID_KINDS.includes(kind)) {
    throw new AppError('STORE_BAD_ARGS', `invalid kind "${kind}"`, { details: { validKinds: VALID_KINDS } });
  }
  const id = crypto.randomUUID();
  const ts = now();
  const code = newPseudoCode(kind);
  db.prepare(
    `INSERT INTO objects (id, kind, code, alias, name_enc, props_json_enc, is_ego, created_ts, updated_ts)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, kind, code, opts.alias ?? null, encName(db, name), encProps(db, props), ts, ts);
  return getById(db, id);
}

/** @returns {object|null} */
function getById(db, id) {
  const row = db.prepare('SELECT * FROM objects WHERE id = ?').get(id);
  return decodeRow(db, row);
}

/** @returns {object|null} the ego object */
function getEgo(db) {
  const row = db.prepare('SELECT * FROM objects WHERE is_ego = 1 LIMIT 1').get();
  return decodeRow(db, row);
}

/**
 * Resolve a reference to a single object. `ref` may be:
 *   - id (UUID)
 *   - code / pseudo-code (person_7f3a...)
 *   - alias (plaintext)
 *   - name (encrypted -> requires scan+decrypt, exact match)
 * @param {object} db
 * @param {string} ref
 * @returns {object|null}
 */
function findByRef(db, ref) {
  if (!ref) return null;
  // exact structural matches first (indexed, no decrypt)
  let row =
    db.prepare('SELECT * FROM objects WHERE id = ?').get(ref) ||
    db.prepare('SELECT * FROM objects WHERE code = ?').get(ref) ||
    db.prepare('SELECT * FROM objects WHERE alias = ?').get(ref);
  if (row) return decodeRow(db, row);

  // fall back to name match (requires decrypting each row)
  const rows = db.prepare('SELECT * FROM objects').all();
  for (const r of rows) {
    const decoded = decodeRow(db, r);
    if (decoded && decoded.name === ref) return decoded;
  }
  return null;
}

/**
 * List objects, optionally filtered by kind.
 * @param {object} db
 * @param {{ kind?: string }} [opts]
 * @returns {object[]}
 */
function list(db, opts = {}) {
  const rows = opts.kind
    ? db.prepare('SELECT * FROM objects WHERE kind = ? ORDER BY created_ts').all(opts.kind)
    : db.prepare('SELECT * FROM objects ORDER BY created_ts').all();
  return rows.map((r) => decodeRow(db, r));
}

module.exports = {
  createEgo,
  createObject,
  findByRef,
  getEgo,
  getById,
  list,
  VALID_KINDS,
};
