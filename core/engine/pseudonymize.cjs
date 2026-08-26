'use strict';

const namesMap = require('../store/names_map.cjs');

/**
 * Pseudonymization boundary. ON by default.
 *
 *   pre(text, ctx)  : replace REAL names -> pseudo-codes BEFORE anything leaves
 *                     to the LLM. Uses names_map.codeFor (creates codes as needed).
 *   post(text, ctx) : replace pseudo-codes -> REAL names, ONLY on local output
 *                     shown to the owner.
 *
 * ctx = {
 *   namesKey: Buffer,          // separate names-key
 *   mapPath?: string,          // names.map.enc path
 *   names: string[],           // known real names to look for in pre()
 *   aliasMode: boolean,        // false => pass-through (off) + caller adds warning
 * }
 *
 * When aliasMode is off we return text unchanged and set .applied=false so the
 * caller can surface a warning in meta.
 */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Load code<->name for the given known names; ensures codes exist. */
function buildDictionary(ctx) {
  const forward = new Map(); // real name -> code
  const reverse = new Map(); // code -> real name
  const opts = { mapPath: ctx.mapPath };
  for (const name of ctx.names || []) {
    if (!name || String(name).trim() === '') continue;
    const code = namesMap.codeFor(name, ctx.namesKey, opts);
    forward.set(name, code);
    reverse.set(code, name);
  }
  return { forward, reverse };
}

/**
 * Replace real names with codes. Longest names first to avoid partial overlaps.
 * @returns {{ text: string, applied: boolean, map: Record<string,string> }}
 */
function pre(text, ctx = {}) {
  const src = String(text ?? '');
  if (ctx.aliasMode === false) {
    return { text: src, applied: false, map: {} };
  }
  const { forward } = buildDictionary(ctx);
  const names = [...forward.keys()].sort((a, b) => b.length - a.length);
  let out = src;
  const used = {};
  for (const name of names) {
    const code = forward.get(name);
    const re = new RegExp(escapeRegExp(name), 'g');
    if (re.test(out)) {
      out = out.replace(re, code);
      used[name] = code;
    }
  }
  return { text: out, applied: true, map: used };
}

/**
 * Replace pseudo-codes with real names (local re-identification).
 * Matches any code token of the shape <prefix>_<hex8> found in the names map.
 * @returns {{ text: string, applied: boolean }}
 */
function post(text, ctx = {}) {
  const src = String(text ?? '');
  if (ctx.aliasMode === false) {
    return { text: src, applied: false };
  }
  // Prefer explicit dictionary when caller supplies known names.
  let reverse;
  if (ctx.names && ctx.names.length) {
    reverse = buildDictionary(ctx).reverse;
  } else {
    const map = namesMap.loadMap(ctx.namesKey, ctx.mapPath); // code -> name
    reverse = new Map(Object.entries(map));
  }
  let out = src;
  // Replace by scanning code-like tokens; longest codes first (all same length,
  // but stable order for determinism).
  const codes = [...reverse.keys()].sort((a, b) => b.length - a.length);
  for (const code of codes) {
    const re = new RegExp(escapeRegExp(code), 'g');
    out = out.replace(re, reverse.get(code));
  }
  return { text: out, applied: true };
}

module.exports = { pre, post, buildDictionary };
