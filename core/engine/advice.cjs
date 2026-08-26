'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../store/errors.cjs');
const objects = require('../store/objects.cjs');
const facts = require('../store/facts.cjs');
const interp = require('../store/interpretations.cjs');
const relations = require('../store/relations.cjs');
const llm = require('./llm.cjs');
const pseudo = require('./pseudonymize.cjs');
const guard = require('./guard.cjs');
const consent = require('./consent.cjs');

/**
 * Advice engine — the key v1 slice.
 *
 * Flow:
 *   1. Assemble context: facts + current interpretations of relevant people
 *      + graph edges (centred on perspectiveRef, default ego).
 *   2. Pseudonymize the context.
 *   3. Compose advice.md (+ system.md) prompt.
 *   4. LLM -> draft advice.
 *   5. Guard (denylist pre-check on request; llm-guard on the DRAFT only).
 *      - block:   advice=null.
 *      - rewrite: guard returns cleaned text; use it instead.
 *      - pass:    use draft as-is.
 *   6. Re-identify (post) and return clean advice.
 *
 * --dry compiles the prompt without LLM/guard/writes.
 * daily mode uses a fixed request string.
 * perspectiveRef (--as <code>): centre the context on a non-ego person.
 */

const DAILY_QUERY =
  'Дай дайджест интриг и приоритетов на сегодня из моей перспективы: где риски, ' +
  'где возможности легитимно усилить позицию, и один-два конкретных хода на день.';

function readPrompt(corePath, name) {
  return fs.readFileSync(path.join(corePath, 'prompts', name), 'utf8');
}

/** Build the context block centred on a perspective object. */
function buildContext({ db, activeLenses, perspectiveId }) {
  const all = objects.list(db);
  const ego = all.find((o) => o.is_ego) || null;
  const byId = new Map(all.map((o) => [o.id, o]));
  const knownNames = all.map((o) => o.name).filter(Boolean);

  // Determine center: ego by default; perspectiveId overrides.
  const center = perspectiveId ? byId.get(perspectiveId) || ego : ego;

  const sections = [];
  const factRefs = []; // {id, shortId, subjectLabel}
  const usedProfiles = []; // {label, lens}
  let fCounter = 0;

  // Per-person facts + current interpretations for active lenses.
  for (const obj of all) {
    if (obj.kind !== 'person') continue;
    const label = obj.is_ego ? 'Я' : obj.code;
    const fList = facts.listFacts(db, obj.id);
    const lines = [];
    for (const f of fList) {
      fCounter += 1;
      const shortId = `f${fCounter}`;
      factRefs.push({ id: f.id, shortId, subjectLabel: label });
      lines.push(`  #${shortId} [${f.source || 'н/д'}] ${f.body}`);
    }
    const interpLines = [];
    for (const lens of activeLenses) {
      const cur = interp.getCurrent(db, obj.id, lens);
      if (cur) {
        usedProfiles.push({ label, lens });
        interpLines.push(`  [профиль:${lens}]\n${indent(cur.body, '    ')}`);
      }
    }
    if (lines.length || interpLines.length) {
      const isCenterObj = center && obj.id === center.id;
      sections.push(
        `### ${label}${obj.is_ego ? ' (ego-центр)' : ''}${isCenterObj && !obj.is_ego ? ' (перспектива)' : ''}\n` +
          (lines.length ? `Факты:\n${lines.join('\n')}\n` : '') +
          (interpLines.length ? `Профили:\n${interpLines.join('\n')}\n` : ''),
      );
    }
  }

  // Graph edges (confirmed + pending), labeled by code.
  const edges = relations.listRelations(db);
  const graphLines = [];
  for (const e of edges) {
    const from = byId.get(e.from_id);
    const to = byId.get(e.to_id);
    const fromL = from ? (from.is_ego ? 'Я' : from.code) : e.from_id;
    const toL = to ? (to.is_ego ? 'Я' : to.code) : e.to_id;
    graphLines.push(`  ${fromL} → ${toL}: ${e.rel} (${e.origin}/${e.status})`);
  }

  // Perspective header when non-ego.
  const perspectiveNote = center && !center.is_ego
    ? `(Контекст строится из перспективы: ${center.code})\n\n`
    : '';

  const contextText =
    (ego ? '' : '(ego-центр не задан — запусти `init`)\n\n') +
    perspectiveNote +
    sections.join('\n') +
    (graphLines.length ? `\n### Граф связей\n${graphLines.join('\n')}\n` : '');

  const centerCode = center ? (center.is_ego ? 'ego' : center.code) : 'ego';
  return { contextText, knownNames, factRefs, usedProfiles, graphCount: graphLines.length, hasEgo: Boolean(ego), centerCode };
}

function indent(text, pad) {
  return String(text).split('\n').map((l) => pad + l).join('\n');
}

/**
 * Compile the advice prompt (used by --dry and the real run).
 * @returns {{ system:string, prompt:string, ctx:object, aliasApplied:boolean }}
 */
function compilePrompt({ db, corePath, query, activeLenses, aliasMode, namesKey, namesMapPath, perspectiveId }) {
  const system = readPrompt(corePath, 'system.md');
  const adviceTpl = readPrompt(corePath, 'advice.md');
  const ctx = buildContext({ db, activeLenses, perspectiveId });

  const pctx = { namesKey, mapPath: namesMapPath, names: ctx.knownNames, aliasMode };
  const safeContext = pseudo.pre(ctx.contextText, pctx);
  const safeQuery = pseudo.pre(query, pctx);

  const prompt = adviceTpl
    .replace('{{QUERY}}', safeQuery.text)
    .replace('{{CONTEXT}}', safeContext.text);

  return { system, prompt, ctx, aliasApplied: safeContext.applied || safeQuery.applied };
}

/**
 * @param {object} args
 * @param {string} [args.perspectiveRef]  person ref to centre on (default ego)
 * @returns {Promise<{advice:string|null, meta:object}>}
 */
async function advise(args) {
  const {
    db, corePath, query, daily, activeLenses, aliasMode, namesKey, namesMapPath,
    model, dry, consentFlag, tty, env, perspectiveRef,
  } = args;

  const effectiveQuery = daily ? DAILY_QUERY : query;
  if (!effectiveQuery || String(effectiveQuery).trim() === '') {
    throw new AppError('ADVICE_BAD_ARGS', 'advice requires a non-empty query');
  }

  // Resolve perspectiveRef -> id (if provided and not ego).
  let perspectiveId = null;
  let perspectiveCode = 'ego';
  if (perspectiveRef) {
    // Try to resolve; if it resolves to ego, treat as default.
    const pObj = objects.findByRef(db, perspectiveRef);
    if (!pObj) {
      throw new AppError('ARGS_MISSING', `--as: person "${perspectiveRef}" not found`);
    }
    if (!pObj.is_ego) {
      perspectiveId = pObj.id;
      perspectiveCode = pObj.code;
    }
  }

  const compiled = compilePrompt({
    db, corePath, query: effectiveQuery, activeLenses, aliasMode, namesKey, namesMapPath, perspectiveId,
  });

  const meta = {
    llm: null,
    dry: Boolean(dry),
    aliasMode: aliasMode !== false,
    guard: null,
    daily: Boolean(daily),
    lenses: activeLenses,
    perspective: perspectiveCode,
  };
  if (aliasMode === false) meta.aliasWarning = 'pseudonymization is OFF; real names sent to the LLM';

  if (dry) {
    return {
      advice: null,
      meta: { ...meta, prompt: compiled.prompt, system: compiled.system, dry: true },
    };
  }

  // Consent gate.
  await consent.ensure(db, { consentFlag, tty });
  meta.consent_given = true;

  // Deterministic denylist on the ORIGINAL request BEFORE calling the LLM.
  const preDeny = guard.denylistCheck(effectiveQuery);
  if (preDeny.hit) {
    const g = await guard.run({
      db, command: daily ? 'daily' : 'advice',
      originalRequest: effectiveQuery, advice: '', corePath, model, env,
    });
    meta.guard = { verdict: g.verdict, reason: g.reason, layer: g.layer };
    return { advice: null, meta };
  }

  // Draft.
  const reply = await llm.complete(
    {
      system: compiled.system,
      messages: [{ role: 'user', content: compiled.prompt }],
      model,
      maxTokens: 2048,
      temperature: 0.5,
    },
    env,
  );
  meta.llm = { provider: reply.provider, model: reply.model, usage: reply.usage };

  // Guard sees ONLY the generated advice (already pseudonymized text).
  const g = await guard.run({
    db, command: daily ? 'daily' : 'advice',
    originalRequest: effectiveQuery, advice: reply.text, corePath, model, env,
  });
  meta.guard = { verdict: g.verdict, reason: g.reason, layer: g.layer };

  // fail-closed on GUARD_UNAVAILABLE.
  if (g.ok === false && g.code === 'GUARD_UNAVAILABLE') {
    return { advice: null, meta, error: { code: 'GUARD_UNAVAILABLE', message: g.reason } };
  }

  if (g.verdict === 'block') {
    // Normal outcome: block => ok:true, advice:null.
    return { advice: null, meta };
  }

  // rewrite: use guard's cleaned text; pass: use original draft.
  const rawAdvice = g.verdict === 'rewrite' ? g.text : reply.text;
  meta.guard.verdict = g.verdict; // ensure rewrite is recorded

  // Re-identify locally.
  const shown = pseudo.post(rawAdvice, {
    namesKey, mapPath: namesMapPath, names: compiled.ctx.knownNames, aliasMode,
  }).text;

  return { advice: shown, meta };
}

module.exports = { advise, compilePrompt, buildContext, DAILY_QUERY };
