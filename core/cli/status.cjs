'use strict';

const { detectDriver } = require('../store/db.cjs');
const keyring = require('../store/keyring.cjs');
const llm = require('../engine/llm.cjs');
const { CONTRACT } = require('./args.cjs');

/**
 * Diagnostics without touching the LLM:
 *   status  -> node version, driver, key sources (no values), consent, aliasMode, counts
 *   doctor  -> status + a live LLM ping
 *   version -> contract + core versions
 */

function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

/** Count rows across the main tables (best-effort). */
function counts(db) {
  const c = {};
  const tables = ['objects', 'facts', 'interpretations', 'relations', 'guard_audit'];
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
      c[t] = Number(row.n);
    } catch {
      c[t] = null;
    }
  }
  return c;
}

function metaGet(db, key) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ db?:object, config:object, env?:object }} args
 */
function status(args) {
  const { db, config, env = process.env } = args;
  const driver = detectDriver();

  const data = {
    node: process.versions.node,
    nodeOk: nodeMajor() >= 20,
    driver,
    contract: CONTRACT,
    provider: llm.selectProvider(env),
    llmBase: llm.baseUrl(env),
    llmModel: env.MACH_LLM_MODEL || config.defaultModel,
    llmFake: llm.isFake(env),
    keys: {
      data: keyring.keySource('data', { dataDir: config.dataDir }),
      names: keyring.keySource('names', { dataDir: config.dataDir }),
      llm: env.MACH_LLM_KEY ? 'env' : null,
    },
    aliasMode: config.aliasMode,
    activeLenses: config.activeLenses,
    dataDir: config.dataDir,
  };

  if (db) {
    data.consent = metaGet(db, 'consent_given') === '1';
    data.counts = counts(db);
  } else {
    data.consent = null;
    data.counts = null;
    data.dbInitialized = false;
  }

  return data;
}

/**
 * doctor = status + live LLM ping.
 * @returns {Promise<object>}
 */
async function doctor(args) {
  const base = status(args);
  const env = args.env || process.env;
  const ping = { attempted: true, ok: false, provider: llm.selectProvider(env), error: null };
  try {
    const reply = await llm.complete(
      {
        messages: [{ role: 'user', content: 'ping — reply with the single word: pong' }],
        model: args.config.defaultModel,
        maxTokens: 16,
        temperature: 0,
      },
      env,
    );
    ping.ok = true;
    ping.provider = reply.provider;
    ping.model = reply.model;
    ping.sample = reply.text.slice(0, 40);
  } catch (err) {
    ping.ok = false;
    ping.error = { code: err.code || 'LLM_ERROR', message: err.message };
  }
  return { ...base, ping };
}

function version() {
  return { contract: CONTRACT, core: CONTRACT, node: process.versions.node };
}

module.exports = { status, doctor, version, nodeMajor };
