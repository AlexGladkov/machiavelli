'use strict';

/**
 * Structured application error with a stable machine-readable code.
 *
 * Codes follow the MACH convention, grouped by subsystem:
 *   - STORE_*      db/store-layer failures (open, migrate, query)
 *   - KEY_*        keyring / key resolution failures
 *   - CRYPTO_*     low-level crypto failures
 *   - DECRYPT_FAILED  authentication tag / AAD mismatch on decrypt
 *   - NO_SQLITE    no usable sqlite driver present
 *   - NAMES_*      names.map (pseudonym) failures
 *
 * @property {string}  code      stable error code (never localise / never change existing ones)
 * @property {boolean} retryable whether a retry could plausibly succeed
 * @property {object}  details   arbitrary structured context (never contains secrets)
 */
class AppError extends Error {
  /**
   * @param {string}  code
   * @param {string}  message
   * @param {{ retryable?: boolean, details?: object, cause?: Error }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.retryable = opts.retryable === true;
    this.details = opts.details || {};
  }

  /** Machine-readable JSON shape (for --json CLI output). */
  toJSON() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/** Convenience: wrap unknown thrown value into AppError with a fallback code. */
function wrap(code, message, err, extra = {}) {
  const details = { ...extra };
  if (err && err.message) details.cause = err.message;
  return new AppError(code, message, { cause: err, details });
}

module.exports = { AppError, wrap };
