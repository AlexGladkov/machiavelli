'use strict';

const crypto = require('node:crypto');
const { encrypt, decrypt } = require('./crypto.cjs');
const { AppError } = require('./errors.cjs');
const { listFacts } = require('./facts.cjs');

/**
 * Interpretations layer — regenerable psycho-profiles, keyed by (subject, lens).
 * Saving a new interpretation marks any prior current one (same subject+lens)
 * as is_current=0 inside a transaction, so exactly one is current per lens.
 * `body` is encrypted with the data-key.
 */

const BODY_AAD = 'interpretations.body_enc';

function now() {
  return Date.now();
}
function toBuf(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

function decodeRow(db, row) {
  if (!row) return null;
  let body;
  try {
    body = decrypt(toBuf(row.body_enc), db.dataKey, BODY_AAD);
  } catch (err) {
    throw new AppError('DECRYPT_FAILED', `failed to decrypt interpretation ${row.id}: ${err.message}`, {
      cause: err,
    });
  }
  let basedOn = [];
  try {
    basedOn = row.based_on_fact_ids_json ? JSON.parse(row.based_on_fact_ids_json) : [];
  } catch {
    basedOn = [];
  }
  return {
    id: row.id,
    subject_id: row.subject_id,
    lens: row.lens,
    body,
    model: row.model,
    based_on_fact_ids: basedOn,
    is_current: !!row.is_current,
    created_ts: row.created_ts,
  };
}

/**
 * Save a new interpretation, superseding the prior current one for the same
 * (subject, lens). Runs in a transaction.
 * @param {object} db
 * @param {string} subjectId
 * @param {string} lens
 * @param {string} body
 * @param {string} [model]
 * @param {string[]} [basedOnFactIds]
 * @returns {object} decoded interpretation
 */
function saveInterpretation(db, subjectId, lens, body, model = null, basedOnFactIds = []) {
  if (!subjectId || !lens || body == null) {
    throw new AppError('STORE_BAD_ARGS', 'saveInterpretation requires subjectId, lens, body');
  }
  const id = crypto.randomUUID();
  const ts = now();

  const tx = db.transaction(() => {
    db.prepare('UPDATE interpretations SET is_current = 0 WHERE subject_id = ? AND lens = ? AND is_current = 1').run(
      subjectId,
      lens,
    );
    db.prepare(
      `INSERT INTO interpretations
         (id, subject_id, lens, body_enc, model, based_on_fact_ids_json, is_current, created_ts)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      id,
      subjectId,
      lens,
      encrypt(String(body), db.dataKey, BODY_AAD),
      model,
      JSON.stringify(Array.isArray(basedOnFactIds) ? basedOnFactIds : []),
      ts,
    );
  });
  tx();

  return decodeRow(db, db.prepare('SELECT * FROM interpretations WHERE id = ?').get(id));
}

/**
 * Current interpretation for (subject, lens), or null.
 * @param {object} db
 * @param {string} subjectId
 * @param {string} lens
 * @returns {object|null}
 */
function getCurrent(db, subjectId, lens) {
  const row = db
    .prepare('SELECT * FROM interpretations WHERE subject_id = ? AND lens = ? AND is_current = 1 LIMIT 1')
    .get(subjectId, lens);
  return decodeRow(db, row);
}

/**
 * True if newer facts exist than the current interpretation for this lens
 * (i.e. the profile should be regenerated). If no current interpretation
 * exists, returns true when the subject has any facts.
 * @param {object} db
 * @param {string} subjectId
 * @param {string} lens
 * @returns {boolean}
 */
function isStale(db, subjectId, lens) {
  const current = getCurrent(db, subjectId, lens);
  // Collision-free staleness: compare the fact-id set the profile was built from
  // against the current active fact set. ms-timestamps collide when a fact and the
  // interpretation land in the same millisecond, so never compare by timestamp.
  const activeIds = listFacts(db, subjectId).map((f) => f.id);
  if (!current) return activeIds.length > 0;
  const basedOn = new Set(current.based_on_fact_ids || []);
  if (activeIds.length !== basedOn.size) return true; // fact added or retracted
  return activeIds.some((id) => !basedOn.has(id)); // membership changed
}

module.exports = {
  saveInterpretation,
  getCurrent,
  isStale,
};
