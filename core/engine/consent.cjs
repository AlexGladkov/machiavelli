'use strict';

const readline = require('node:readline');
const { AppError } = require('../store/errors.cjs');

/**
 * Consent gate for advice/profile/daily. Consent is recorded once in meta
 * (key = 'consent_given'). Resolution:
 *   - already granted in DB -> pass
 *   - --consent flag        -> grant + persist
 *   - TTY                   -> blocking prompt on stderr; on "yes" grant + persist
 *   - non-TTY, no flag      -> throw CONSENT_REQUIRED (exit 2 at CLI layer)
 */

function metaGet(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function metaSet(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

function isGranted(db) {
  return metaGet(db, 'consent_given') === '1';
}

function grant(db) {
  metaSet(db, 'consent_given', '1');
  metaSet(db, 'consent_ts', String(Date.now()));
}

const CONSENT_TEXT =
  'Machiavelli строит психопрофили реальных людей и советует по влиянию на них.\n' +
  'Используй этично и в рамках закона. Данные шифруются, но ответственность на тебе.\n' +
  'Продолжить? [y/N] ';

function askTTY() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(CONSENT_TEXT, (answer) => {
      rl.close();
      resolve(/^\s*(y|yes|да|д)\s*$/i.test(answer || ''));
    });
  });
}

/**
 * Ensure consent. Returns { granted:true, justGranted:boolean }.
 * Throws AppError CONSENT_REQUIRED when it cannot be obtained.
 * @param {object} db
 * @param {{ consentFlag?: boolean, tty?: boolean }} opts
 */
async function ensure(db, opts = {}) {
  if (isGranted(db)) return { granted: true, justGranted: false };

  if (opts.consentFlag) {
    grant(db);
    return { granted: true, justGranted: true };
  }

  const tty = opts.tty !== undefined ? opts.tty : Boolean(process.stdin.isTTY);
  if (tty) {
    const yes = await askTTY();
    if (yes) {
      grant(db);
      return { granted: true, justGranted: true };
    }
    throw new AppError('CONSENT_REQUIRED', 'consent declined by user', { retryable: false });
  }

  throw new AppError(
    'CONSENT_REQUIRED',
    'consent required: run interactively or pass --consent to proceed',
    { retryable: false },
  );
}

module.exports = { ensure, isGranted, grant, metaGet, metaSet };
