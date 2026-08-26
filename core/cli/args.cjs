'use strict';

const readline = require('node:readline');

/**
 * Minimal argparser (no commander). Splits argv into positionals + flags.
 *
 * Boolean flags: --json --dry --regen --consent
 * Value flags:   --lens a,b   --model NAME   --alias-mode off   --person X
 * Also supports --flag=value form.
 *
 * makeEnvelope(cmd, {ok,data,error,meta}) -> unified envelope for every command.
 */

const BOOL_FLAGS = new Set(['json', 'dry', 'regen', 'consent', 'help', 'version', 'confirm', 'stdin']);
const VALUE_FLAGS = new Set(['lens', 'model', 'alias-mode', 'person', 'as', 'kind', 'value', 'body']);

const CONTRACT = '0.1.0';

function parse(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      let name = tok.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const key = camel(name);
      if (BOOL_FLAGS.has(name)) {
        flags[key] = value === undefined ? true : value !== 'false';
      } else if (VALUE_FLAGS.has(name)) {
        if (value === undefined) {
          value = argv[i + 1];
          i++;
        }
        flags[key] = value;
      } else {
        // unknown flag: accept value form loosely, else boolean true
        if (value === undefined && argv[i + 1] && !argv[i + 1].startsWith('--')) {
          value = argv[i + 1];
          i++;
        }
        flags[key] = value === undefined ? true : value;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function camel(s) {
  return String(s).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Build the unified envelope.
 * @param {string} cmd
 * @param {{ ok:boolean, data?:any, error?:object, meta?:object, core?:string, dry?:boolean }} parts
 */
function makeEnvelope(cmd, parts = {}) {
  const meta = {
    contract: CONTRACT,
    core: parts.core || CONTRACT,
    ts: new Date().toISOString(),
    dry: Boolean(parts.dry ?? (parts.meta && parts.meta.dry) ?? false),
    llm: (parts.meta && parts.meta.llm) ?? null,
    guard: (parts.meta && parts.meta.guard) ?? null,
    ...(parts.meta || {}),
  };
  return {
    ok: Boolean(parts.ok),
    cmd,
    data: parts.data ?? null,
    error: parts.error
      ? {
          code: parts.error.code || 'ERROR',
          message: parts.error.message || String(parts.error),
          retryable: Boolean(parts.error.retryable),
          details: parts.error.details || {},
        }
      : null,
    meta,
  };
}

/** Print an envelope: JSON to stdout when --json, human summary otherwise. */
function printEnvelope(env, flags = {}) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(env)}\n`);
    return;
  }
  // Human-readable to stdout (data) / stderr (status/errors).
  if (env.ok) {
    if (env.data && typeof env.data === 'object' && env.data.text) {
      process.stdout.write(`${env.data.text}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(env.data, null, 2)}\n`);
    }
  } else {
    process.stderr.write(`[${env.cmd}] ERROR ${env.error.code}: ${env.error.message}\n`);
  }
}

// ---- TTY interactive helpers (init/person) --------------------------------

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

function isTTY() {
  return Boolean(process.stdin.isTTY);
}

module.exports = { parse, makeEnvelope, printEnvelope, ask, isTTY, CONTRACT, camel };
