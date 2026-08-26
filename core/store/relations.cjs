'use strict';

const crypto = require('node:crypto');
const { encrypt, decrypt } = require('./crypto.cjs');
const { AppError } = require('./errors.cjs');

/**
 * Relations layer — directed graph edges between objects.
 * The relation type (`rel`) is encrypted (rel_enc) with the data-key.
 * `origin` (fact|interp) and `status` (confirmed|pending) stay plaintext so
 * the graph can be filtered/indexed without decryption.
 */

const REL_AAD = 'relations.rel_enc';
const VALID_ORIGIN = ['fact', 'interp'];
const VALID_STATUS = ['confirmed', 'pending'];

function now() {
  return Date.now();
}
function toBuf(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

function decodeRow(db, row) {
  if (!row) return null;
  let rel;
  try {
    rel = decrypt(toBuf(row.rel_enc), db.dataKey, REL_AAD);
  } catch (err) {
    throw new AppError('DECRYPT_FAILED', `failed to decrypt relation ${row.id}: ${err.message}`, { cause: err });
  }
  return {
    id: row.id,
    from_id: row.from_id,
    to_id: row.to_id,
    rel,
    origin: row.origin,
    status: row.status,
    created_ts: row.created_ts,
  };
}

/**
 * Add a directed relation edge.
 * @param {object} db
 * @param {string} fromId
 * @param {string} rel   relation type (e.g. reports_to, ally, rival, mentor)
 * @param {string} toId
 * @param {{ origin?: 'fact'|'interp', status?: 'confirmed'|'pending' }} [opts]
 *        default: fact-origin edges are confirmed, interp-origin edges are pending
 * @returns {object} decoded relation
 */
function addRelation(db, fromId, rel, toId, opts = {}) {
  if (!fromId || !rel || !toId) {
    throw new AppError('STORE_BAD_ARGS', 'addRelation requires fromId, rel, toId');
  }
  const origin = opts.origin ?? 'fact';
  const status = opts.status ?? (origin === 'interp' ? 'pending' : 'confirmed');
  if (!VALID_ORIGIN.includes(origin)) {
    throw new AppError('STORE_BAD_ARGS', `invalid origin "${origin}"`, { details: { valid: VALID_ORIGIN } });
  }
  if (!VALID_STATUS.includes(status)) {
    throw new AppError('STORE_BAD_ARGS', `invalid status "${status}"`, { details: { valid: VALID_STATUS } });
  }

  const id = crypto.randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO relations (id, from_id, to_id, rel_enc, origin, status, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, fromId, toId, encrypt(String(rel), db.dataKey, REL_AAD), origin, status, ts);

  return decodeRow(db, db.prepare('SELECT * FROM relations WHERE id = ?').get(id));
}

/**
 * Confirm a pending edge -> confirmed. Idempotent: confirming an already
 * confirmed edge is a no-op success.
 * @param {object} db
 * @param {string} edgeId
 * @returns {object} decoded relation
 */
function confirm(db, edgeId) {
  const row = db.prepare('SELECT * FROM relations WHERE id = ?').get(edgeId);
  if (!row) throw new AppError('STORE_NOT_FOUND', `relation ${edgeId} not found`, { details: { edgeId } });
  if (row.status !== 'confirmed') {
    db.prepare('UPDATE relations SET status = ? WHERE id = ?').run('confirmed', edgeId);
  }
  return decodeRow(db, db.prepare('SELECT * FROM relations WHERE id = ?').get(edgeId));
}

/**
 * List relations, optionally filtered by person (either endpoint) and/or status.
 * @param {object} db
 * @param {{ personId?: string, status?: string }} [opts]
 * @returns {object[]}
 */
function listRelations(db, opts = {}) {
  const where = [];
  const params = [];
  if (opts.personId) {
    where.push('(from_id = ? OR to_id = ?)');
    params.push(opts.personId, opts.personId);
  }
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  const sql =
    'SELECT * FROM relations' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_ts';
  return db.prepare(sql).all(...params).map((r) => decodeRow(db, r));
}

module.exports = {
  addRelation,
  confirm,
  listRelations,
  VALID_ORIGIN,
  VALID_STATUS,
};
