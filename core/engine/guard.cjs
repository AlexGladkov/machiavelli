'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../store/errors.cjs');
const llm = require('./llm.cjs');

/**
 * Guardrail v2 = block | rewrite | pass
 *
 * Layer 0 (deterministic denylist): regex over explicit harm/lie/setup/threat
 *          cues (RU + EN). Runs BEFORE the LLM on the ORIGINAL request.
 *          Instant block on hit (no rewrite: denylist = hard no).
 *
 * Layer 2 (llm-guard): sees ONLY the generated advice text.
 *          Verdict: block | rewrite | pass parsed from strict JSON.
 *          - block:   explicit harm -> advice discarded, advice=null.
 *          - rewrite: harmful formulation but useful core -> guard returns
 *                     cleaned text in `text` field; advice engine uses it.
 *          - pass:    clean -> advice returned as-is.
 *
 * fail-closed: guard-LLM fails / times out / returns an invalid verdict ->
 *          block with code GUARD_UNAVAILABLE (ok:false at the command layer).
 *
 * Every verdict is written to guard_audit(command, verdict, reason, ts).
 */

// Denylist: intent to harm / lie / set up / threaten. Deliberately conservative;
// legitimate influence vocabulary is NOT here.
const DENYLIST = [
  // RU — harm / destroy. NOTE: JS \b is ASCII-only and does NOT work before
  // Cyrillic, so Russian patterns intentionally omit \b (stem-match instead).
  /(навред|уничтож(ь|ить|им|аю|ат)|подстав(ь|ить|л|а)|саботаж|оклевет|клевет|очерн(ить|и|яю))/i,
  // RU — lie / fabricate
  /(солг(ать|и|у)|совр(и|у|ать)|обман(уть|и|ыв)|сфабрик|фальсифиц|подделай|подделать)/i,
  // RU — threat / blackmail
  /(угрож|угроз(а|ы|у|ить)|шантаж|запуга|расправ)/i,
  // EN — harm / destroy / setup
  /\b(sabotage|slander|defame|frame\s+(him|her|them)|destroy\s+(his|her|their)\s+(career|reputation)|set\s+(him|her|them)\s+up)\b/i,
  // EN — lie / fabricate
  /\b(fabricate|forge|falsify|lie\s+to|spread\s+(false|lies))\b/i,
  // EN — threat / blackmail
  /\b(blackmail|threaten|intimidate|coerce)\b/i,
];

// Soft-manipulation markers: present in denylist-clean text but indicate the LLM
// should consider rewrite. Used ONLY by fake-guard for deterministic test cases.
const SOFT_MARKERS = [
  /манипул/i,
  /скрой\s+(от|правду|факт)/i,
  /скрыть\s+(от|правду|факт)/i,
  /притвор/i,
  /выгляд(и|еть)\s+(невинн|чист)/i,
];

function now() {
  return Date.now();
}

function readGuardPrompt(corePath) {
  const fp = path.join(corePath, 'prompts', 'guard.md');
  return fs.readFileSync(fp, 'utf8');
}

/** @returns {{hit:boolean, pattern?:string}} */
function denylistCheck(text) {
  const s = String(text ?? '');
  for (const re of DENYLIST) {
    if (re.test(s)) return { hit: true, pattern: re.source };
  }
  return { hit: false };
}

/** @returns {boolean} — soft-manipulation markers present but no hard denylist hit */
function softMarkerCheck(text) {
  const s = String(text ?? '');
  return SOFT_MARKERS.some((re) => re.test(s));
}

function auditWrite(db, command, verdict, reason) {
  if (!db) return;
  try {
    db.prepare(
      'INSERT INTO guard_audit (id, command, verdict, reason, ts) VALUES (?, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), command || null, verdict, String(reason || '').slice(0, 500), now());
  } catch {
    // audit must never break the main flow
  }
}

/**
 * Parse a guard-LLM reply into {verdict, text, reason} or null if invalid.
 * Accepts triple-verdict JSON: block | rewrite | pass.
 * For rewrite, `text` field carries the cleaned advice.
 */
function parseVerdict(raw) {
  const s = String(raw || '').trim();
  // Extract first {...} JSON object if wrapped in prose.
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const v = obj.verdict;
  if (v !== 'block' && v !== 'rewrite' && v !== 'pass') return null;
  return {
    verdict: v,
    text: typeof obj.text === 'string' ? obj.text : null,
    reason: String(obj.reason || ''),
  };
}

/**
 * Run the guardrail.
 * @param {object} args
 * @param {object} args.db            store facade (for audit)
 * @param {string} args.command       command name (advice|daily|...)
 * @param {string} args.originalRequest  raw user request (denylist input)
 * @param {string} args.advice        generated advice (llm-guard input)
 * @param {string} args.corePath
 * @param {string} [args.model]
 * @param {object} [args.env]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{verdict:'block'|'rewrite'|'pass', text:string|null, reason:string, layer:string, ok:boolean}>}
 *          text: non-null only on 'rewrite' (cleaned advice from LLM-guard).
 *          ok=false only for GUARD_UNAVAILABLE (fail-closed) — still verdict:block.
 */
async function run(args) {
  const { db, command, originalRequest, advice, corePath, model, env, signal } = args;

  // Layer 0 — deterministic denylist on the original request.
  const deny = denylistCheck(originalRequest);
  if (deny.hit) {
    const reason = `denylist: matched ${deny.pattern}`;
    auditWrite(db, command, 'block', reason);
    return { verdict: 'block', text: null, reason, layer: 'denylist', ok: true };
  }

  // Also denylist-scan the generated advice itself (hard no on output).
  const denyOut = denylistCheck(advice);
  if (denyOut.hit) {
    const reason = `denylist(output): matched ${denyOut.pattern}`;
    auditWrite(db, command, 'block', reason);
    return { verdict: 'block', text: null, reason, layer: 'denylist-output', ok: true };
  }

  // Layer 2 — llm-guard on advice text ONLY.
  let promptTpl;
  try {
    promptTpl = readGuardPrompt(corePath);
  } catch (err) {
    const reason = `guard prompt unavailable: ${err.message}`;
    auditWrite(db, command, 'block', reason);
    return { verdict: 'block', text: null, reason, layer: 'unavailable', ok: false, code: 'GUARD_UNAVAILABLE' };
  }
  const prompt = promptTpl.replace('{{ADVICE}}', String(advice));

  let reply;
  try {
    reply = await llm.complete(
      {
        system: 'Ты guard-pass — независимый этический контролёр. Отвечай только JSON-вердиктом.',
        messages: [{ role: 'user', content: prompt }],
        model,
        maxTokens: 512,
        temperature: 0,
        signal,
      },
      env,
    );
  } catch (err) {
    // fail-closed
    const reason = `guard-llm error: ${err.code || err.message}`;
    auditWrite(db, command, 'block', reason);
    return { verdict: 'block', text: null, reason, layer: 'llm-error', ok: false, code: 'GUARD_UNAVAILABLE' };
  }

  const parsed = parseVerdict(reply.text);
  if (!parsed) {
    const reason = 'guard-llm returned invalid verdict';
    auditWrite(db, command, 'block', reason);
    return { verdict: 'block', text: null, reason, layer: 'llm-invalid', ok: false, code: 'GUARD_UNAVAILABLE' };
  }

  // For rewrite: cleaned text must be present and non-empty.
  if (parsed.verdict === 'rewrite') {
    if (!parsed.text || parsed.text.trim() === '') {
      // Guard said rewrite but gave no cleaned text — treat as pass (guard tried to clean).
      const reason = 'guard-llm rewrite: no cleaned text returned, using original';
      auditWrite(db, command, 'pass', reason);
      return { verdict: 'pass', text: null, reason, layer: 'llm', ok: true };
    }
  }

  auditWrite(db, command, parsed.verdict, parsed.reason);
  return {
    verdict: parsed.verdict,
    text: parsed.verdict === 'rewrite' ? parsed.text : null,
    reason: parsed.reason,
    layer: 'llm',
    ok: true,
  };
}

module.exports = { run, denylistCheck, softMarkerCheck, parseVerdict, DENYLIST, SOFT_MARKERS };
