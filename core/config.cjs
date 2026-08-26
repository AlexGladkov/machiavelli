'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppError } = require('./store/errors.cjs');

// XDG-compliant default data directory.
// Precedence: XDG_DATA_HOME env > ~/.local/share > fallback.
// Keeps user data in $HOME, never in the install/plugin directory.
function xdgDataDir() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'machiavelli');
}

/**
 * Flat config resolution, done BEFORE the DB is opened.
 *
 * Precedence (first hit wins): CLI flag > ENV > config file > default.
 *
 * Config file: ~/.config/machiavelli/config.json (flat JSON), keys:
 *   activeLenses  string[]  default ['leverage']
 *   provider      'anthropic'|'openai-compat' (informational; real switch is MACH_LLM_URL)
 *   aliasMode     boolean   default true  (pseudonymization ON)
 *   dataDir       string    default <projectRoot>/data
 *   corePath      string    default <this core/ dir>
 *   defaultModel  string    default 'claude-3-5-sonnet-latest'
 */

const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';

function configPath() {
  return path.join(os.homedir(), '.config', 'machiavelli', 'config.json');
}

function projectRoot() {
  return path.resolve(__dirname, '..');
}

/** Read + parse the flat config file. Returns {} if absent; throws on corrupt JSON. */
function readConfigFile(fp) {
  const p = fp || configPath();
  if (!fs.existsSync(p)) return {};
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new AppError('CONFIG_READ_FAILED', `cannot read config ${p}: ${err.message}`, { cause: err });
  }
  try {
    const obj = JSON.parse(raw);
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('config must be a flat JSON object');
    }
    return obj;
  } catch (err) {
    throw new AppError('CONFIG_CORRUPT', `config ${p} is not valid flat JSON: ${err.message}`, { cause: err });
  }
}

/** Parse a truthy/falsey env or flag value into a boolean, tolerant of strings. */
function toBool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

/**
 * Resolve the effective config.
 * @param {object} [flags] parsed CLI flags (see cli/args.cjs)
 * @param {object} [env]   process.env
 * @param {{ configPath?: string }} [opts]
 * @returns {object} resolved config
 */
function resolveConfig(flags = {}, env = process.env, opts = {}) {
  const file = readConfigFile(opts.configPath);
  const root = projectRoot();

  // activeLenses: CLI --lens a,b > ENV MACH_LENSES > config > default
  let activeLenses;
  if (flags.lens) {
    activeLenses = String(flags.lens).split(',').map((s) => s.trim()).filter(Boolean);
  } else if (env.MACH_LENSES) {
    activeLenses = String(env.MACH_LENSES).split(',').map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(file.activeLenses) && file.activeLenses.length) {
    activeLenses = file.activeLenses.slice();
  } else {
    activeLenses = ['leverage'];
  }

  // aliasMode: --alias-mode off disables; ENV MACH_ALIAS_MODE; config; default true
  let aliasMode;
  if (flags.aliasMode !== undefined) {
    aliasMode = String(flags.aliasMode).toLowerCase() !== 'off';
  } else if (env.MACH_ALIAS_MODE !== undefined) {
    aliasMode = String(env.MACH_ALIAS_MODE).toLowerCase() !== 'off' && toBool(env.MACH_ALIAS_MODE, true);
  } else {
    aliasMode = toBool(file.aliasMode, true);
  }

  const dataDir = firstDefined(env.MACH_DATA_DIR, file.dataDir, xdgDataDir());
  const corePath = firstDefined(file.corePath, __dirname);
  const defaultModel = firstDefined(flags.model, env.MACH_LLM_MODEL, file.defaultModel, DEFAULT_MODEL);
  const provider = firstDefined(
    env.MACH_LLM_URL ? 'openai-compat' : undefined,
    file.provider,
    'anthropic',
  );

  // MACH_CIPHER: field (default, AES-GCM field-level) | sqlcipher (opt-in, requires
  // better-sqlite3-multiple-ciphers, unavailable on Node >= 26 due to native build issues).
  const cipher = firstDefined(env.MACH_CIPHER, file.cipher, 'field');

  return {
    activeLenses,
    aliasMode,
    dataDir,
    corePath,
    defaultModel,
    provider,
    cipher,
    dbPath: path.join(dataDir, 'machiavelli.db'),
    namesMapPath: path.join(dataDir, 'names.map.enc'),
    configPath: opts.configPath || configPath(),
    projectRoot: root,
  };
}

module.exports = {
  resolveConfig,
  readConfigFile,
  configPath,
  projectRoot,
  DEFAULT_MODEL,
};
