'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors.cjs');

/**
 * Field-level AES-256-GCM encryption.
 *
 * Blob layout (bytes):
 *   [0]        version byte, currently 0x01
 *   [1..12]    12-byte random IV (nonce)
 *   [13..28]   16-byte GCM auth tag
 *   [29..]     ciphertext
 *
 * AAD (additional authenticated data) is REQUIRED and MUST be the logical
 * "table.column" string (e.g. "objects.name_enc"). Binding the AAD prevents
 * a ciphertext from being replayed into a different column and still decrypting.
 *
 * The key is always passed in by the caller (never read from disk/keychain here)
 * so this module stays pure and trivially unit-testable.
 */

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;

/** @param {Buffer} key */
function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw new AppError('CRYPTO_BAD_KEY', `encryption key must be a ${KEY_LEN}-byte Buffer`, {
      details: { got: Buffer.isBuffer(key) ? key.length : typeof key },
    });
  }
}

/** @param {string} aad */
function assertAad(aad) {
  if (typeof aad !== 'string' || aad.length === 0) {
    throw new AppError('CRYPTO_BAD_AAD', 'aad must be a non-empty "table.column" string');
  }
}

/**
 * Encrypt plaintext into a self-describing GCM blob.
 * @param {string|Buffer} plaintext
 * @param {Buffer} key   32-byte key
 * @param {string} aad   "table.column"
 * @returns {Buffer}
 */
function encrypt(plaintext, key, aad) {
  assertKey(key);
  assertAad(aad);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');

  const iv = crypto.randomBytes(IV_LEN); // fresh nonce per encryption
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

/**
 * Decrypt a GCM blob produced by encrypt(). Throws DECRYPT_FAILED on any
 * tampering (wrong key, wrong AAD, corrupted bytes).
 * @param {Buffer} blob
 * @param {Buffer} key
 * @param {string} aad
 * @param {{ asString?: boolean }} [opts] default returns utf8 string
 * @returns {string|Buffer}
 */
function decrypt(blob, key, aad, opts = {}) {
  assertKey(key);
  assertAad(aad);
  if (!Buffer.isBuffer(blob) || blob.length < HEADER_LEN) {
    throw new AppError('DECRYPT_FAILED', 'ciphertext blob too short or not a buffer', {
      details: { len: Buffer.isBuffer(blob) ? blob.length : typeof blob },
    });
  }
  if (blob[0] !== VERSION) {
    throw new AppError('DECRYPT_FAILED', `unsupported blob version 0x${blob[0].toString(16)}`);
  }

  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, HEADER_LEN);
  const ct = blob.subarray(HEADER_LEN);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return opts.asString === false ? pt : pt.toString('utf8');
  } catch (err) {
    // GCM auth failure (bad key/aad/tag) lands here.
    throw new AppError('DECRYPT_FAILED', 'authentication failed: wrong key, aad, or corrupted data', {
      cause: err,
      details: { aad },
    });
  }
}

/**
 * Generate a CSPRNG pseudo-code, e.g. "person_7f3a91cc".
 * NOT a hash of the name — purely random, unlinkable to the real value.
 * @param {string} [prefix='person']
 * @returns {string}
 */
function newPseudoCode(prefix = 'person') {
  const clean = String(prefix).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'obj';
  return `${clean}_${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
  encrypt,
  decrypt,
  newPseudoCode,
  VERSION,
  IV_LEN,
  TAG_LEN,
  KEY_LEN,
  HEADER_LEN,
};
