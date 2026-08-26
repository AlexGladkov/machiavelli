#!/usr/bin/env node
'use strict';

/**
 * Machiavelli CLI entrypoint (thin). Routes subcommands, resolves config/keys
 * lazily, opens the store on demand, and wraps every result in the unified
 * envelope. Exit codes:
 *   0  normal (even ok:false)
 *   1  internal error
 *   2  bad args / consent
 *   3  environment (no node>=20 / no driver / missing key)
 */

const { AppError } = require('./store/errors.cjs');
const { resolveConfig } = require('./config.cjs');
const { detectDriver, openStore } = require('./store/db.cjs');
const keyring = require('./store/keyring.cjs');
const argsMod = require('./cli/args.cjs');
const statusMod = require('./cli/status.cjs');

const objects = require('./store/objects.cjs');
const facts = require('./store/facts.cjs');
const relations = require('./store/relations.cjs');
const interp = require('./store/interpretations.cjs');
const { encrypt, decrypt } = require('./store/crypto.cjs');
const namesMap = require('./store/names_map.cjs');
const profileEngine = require('./engine/profile.cjs');
const adviceEngine = require('./engine/advice.cjs');

const { makeEnvelope, printEnvelope, parse, ask, isTTY } = argsMod;

const ENV_ERRORS = new Set([
  'NODE_TOO_OLD', 'NO_SQLITE', 'KEY_MISSING', 'KEY_INVALID', 'KEY_INSECURE_PERMS', 'LLM_NO_KEY',
]);
const ARG_ERRORS = new Set([
  'ARGS_UNKNOWN_CMD', 'ARGS_MISSING', 'CONSENT_REQUIRED', 'STORE_BAD_ARGS', 'ADVICE_BAD_ARGS',
]);

function checkNode() {
  if (statusMod.nodeMajor() < 20) {
    throw new AppError('NODE_TOO_OLD', `Node >= 20 required, got ${process.versions.node}`);
  }
}

function checkDeps() {
  if (!detectDriver()) {
    throw new AppError('NO_SQLITE', 'no sqlite driver: use Node >= 22.5 or install better-sqlite3');
  }
}

/** Resolve keys; generate on `init` if absent. */
function resolveKeys(config, { allowGenerate } = {}) {
  const opts = { dataDir: config.dataDir };
  const out = {};
  for (const kind of ['data', 'names']) {
    try {
      out[kind] = keyring.resolveKey(kind, opts);
    } catch (err) {
      if (err.code === 'KEY_MISSING' && allowGenerate) {
        out[kind] = keyring.generateKey(kind, opts).key;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function openDb(config, keys) {
  return openStore({ dbPath: config.dbPath, dataKey: keys.data, allowInRepo: true });
}

// ---- command handlers ------------------------------------------------------

async function cmdInit(ctx) {
  const { config } = ctx;
  const keys = resolveKeys(config, { allowGenerate: true });
  const db = openDb(config, keys);
  ctx.db = db;

  let name = 'Me';
  let title = '';
  if (isTTY() && !ctx.flags.json) {
    name = (await ask('Твоё имя (ego-центр) [Me]: ')) || 'Me';
    title = await ask('Твоя должность (опц.): ');
  } else {
    name = ctx.positionals[1] || 'Me';
  }

  const existing = objects.getEgo(db);
  if (existing) {
    return makeEnvelope('init', {
      ok: true,
      data: { egoId: existing.id, code: existing.code, alreadyInitialized: true },
      meta: {},
    });
  }
  const ego = objects.createEgo(db, { name, props: title ? { title } : {} });
  return makeEnvelope('init', {
    ok: true,
    data: { egoId: ego.id, code: ego.code, name, title: title || null },
    meta: {},
  });
}

async function cmdPerson(ctx) {
  const { config, positionals } = ctx;
  const keys = resolveKeys(config);
  const db = openDb(config, keys);
  ctx.db = db;

  let desc = positionals.slice(1).join(' ').trim();
  if (!desc && isTTY() && !ctx.flags.json) {
    desc = await ask('Имя человека / описание: ');
  }
  if (!desc) throw new AppError('ARGS_MISSING', 'person requires a name/description');

  const obj = objects.createObject(db, 'person', desc, {});
  // Optional relation mini-interview at TTY.
  let relation = null;
  if (isTTY() && !ctx.flags.json) {
    const rel = await ask('Связь с тобой (reports_to/ally/rival/mentor/влияние, пусто=пропустить): ');
    if (rel) {
      const ego = objects.getEgo(db);
      if (ego) {
        const edge = relations.addRelation(db, obj.id, rel, ego.id, { origin: 'fact', status: 'confirmed' });
        relation = { id: edge.id, rel: edge.rel };
      }
    }
  }
  return makeEnvelope('person', {
    ok: true,
    data: { id: obj.id, code: obj.code, name: desc, relation },
    meta: {},
  });
}

function cmdFact(ctx) {
  const { config, positionals } = ctx;
  const keys = resolveKeys(config);
  const db = openDb(config, keys);
  ctx.db = db;

  const personRef = positionals[1];
  const body = positionals.slice(2).join(' ').trim();
  if (!personRef || !body) throw new AppError('ARGS_MISSING', 'fact requires <person> "<fact text>"');

  const subject = objects.findByRef(db, personRef);
  if (!subject) throw new AppError('PERSON_NOT_FOUND', `person "${personRef}" not found`);

  const res = facts.addFact(db, subject.id, body, { source: 'user' });
  return makeEnvelope('fact', {
    ok: true,
    data: res.created
      ? { created: true, factId: res.fact.id, subject: subject.code }
      : { created: false, duplicateOf: res.duplicateOf },
    meta: {},
  });
}

async function cmdProfile(ctx) {
  const { config, positionals, flags } = ctx;
  const keys = resolveKeys(config);
  const db = openDb(config, keys);
  ctx.db = db;

  const personRef = positionals[1];
  if (!personRef) throw new AppError('ARGS_MISSING', 'profile requires <person>');

  const { results, meta } = await profileEngine.generate({
    db,
    corePath: __dirname, // bundled assets (lenses/, prompts/) live under core/, not the adapter-facing config.corePath
    personRef,
    lenses: config.activeLenses,
    aliasMode: config.aliasMode,
    namesKey: keys.names,
    namesMapPath: config.namesMapPath,
    model: config.defaultModel,
    dry: Boolean(flags.dry),
    regen: Boolean(flags.regen),
    consentFlag: Boolean(flags.consent),
    tty: isTTY(),
  });

  return makeEnvelope('profile', { ok: true, data: { results }, meta, dry: Boolean(flags.dry) });
}

async function cmdAdvice(ctx, daily = false) {
  const { config, positionals, flags } = ctx;
  const keys = resolveKeys(config);
  const db = openDb(config, keys);
  ctx.db = db;

  const query = daily ? '' : positionals.slice(1).join(' ').trim();
  if (!daily && !query) throw new AppError('ADVICE_BAD_ARGS', 'advice requires "<query>"');

  // --as <personRef>: non-ego perspective
  const perspectiveRef = flags.as || null;

  const { advice, meta, error } = await adviceEngine.advise({
    db,
    corePath: __dirname,
    query,
    daily,
    activeLenses: config.activeLenses,
    aliasMode: config.aliasMode,
    namesKey: keys.names,
    namesMapPath: config.namesMapPath,
    model: config.defaultModel,
    dry: Boolean(flags.dry),
    consentFlag: Boolean(flags.consent),
    tty: isTTY(),
    perspectiveRef,
  });

  const cmd = daily ? 'daily' : 'advice';
  if (error && error.code === 'GUARD_UNAVAILABLE') {
    return makeEnvelope(cmd, { ok: false, data: { advice: null }, error, meta, dry: Boolean(flags.dry) });
  }
  return makeEnvelope(cmd, {
    ok: true,
    data: { advice, text: advice || undefined, prompt: meta.prompt },
    meta,
    dry: Boolean(flags.dry),
  });
}

function cmdGraph(ctx) {
  const { config, flags } = ctx;
  const keys = resolveKeys(config);
  const db = openDb(config, keys);
  ctx.db = db;

  let personId;
  if (flags.person) {
    const p = objects.findByRef(db, flags.person);
    if (!p) throw new AppError('PERSON_NOT_FOUND', `person "${flags.person}" not found`);
    personId = p.id;
  }
  const edges = relations.listRelations(db, personId ? { personId } : {});
  const byId = new Map(objects.list(db).map((o) => [o.id, o]));
  const view = edges.map((e) => ({
    id: e.id,
    from: labelOf(byId.get(e.from_id)),
    to: labelOf(byId.get(e.to_id)),
    rel: e.rel,
    origin: e.origin,
    status: e.status,
  }));
  return makeEnvelope('graph', { ok: true, data: { edges: view, count: view.length }, meta: {} });
}

function labelOf(obj) {
  if (!obj) return null;
  return obj.is_ego ? 'Я' : obj.code;
}

function cmdRelation(ctx) {
  const { config, positionals } = ctx;
  const keys = resolveKeys(config);
  const db = openDb(config, keys);
  ctx.db = db;

  const sub = positionals[1];
  if (sub === 'confirm') {
    const edgeId = positionals[2];
    if (!edgeId) throw new AppError('ARGS_MISSING', 'relation confirm requires <edge_id>');
    const edge = relations.confirm(db, edgeId);
    return makeEnvelope('relation', { ok: true, data: { id: edge.id, status: edge.status, rel: edge.rel }, meta: {} });
  }
  if (sub === 'list') {
    const edges = relations.listRelations(db);
    return makeEnvelope('relation', { ok: true, data: { edges, count: edges.length }, meta: {} });
  }
  throw new AppError('ARGS_UNKNOWN_CMD', `unknown relation subcommand "${sub}" (confirm|list)`);
}

function cmdStatus(ctx) {
  const { config } = ctx;
  let db = null;
  try {
    const keys = resolveKeys(config);
    if (require('node:fs').existsSync(config.dbPath)) db = openDb(config, keys);
  } catch {
    // status must work even without keys/db
  }
  ctx.db = db;
  const data = statusMod.status({ db, config });
  return makeEnvelope('status', { ok: true, data, meta: {} });
}

async function cmdDoctor(ctx) {
  const { config } = ctx;
  let db = null;
  try {
    const keys = resolveKeys(config);
    if (require('node:fs').existsSync(config.dbPath)) db = openDb(config, keys);
  } catch {
    /* ignore */
  }
  ctx.db = db;
  const data = await statusMod.doctor({ db, config });
  const pingOk = data.ping.ok;
  const pingErr = !pingOk ? data.ping.error : null;
  return makeEnvelope('doctor', {
    ok: pingOk,
    data,
    meta: { llm: data.ping.ok ? { provider: data.ping.provider, model: data.ping.model } : null },
    error: pingErr ? { code: pingErr.code || 'LLM_ERROR', message: pingErr.message } : null,
  });
}

function cmdVersion() {
  return makeEnvelope('version', { ok: true, data: statusMod.version(), meta: {} });
}

// ---- key command -----------------------------------------------------------

function cmdKey(ctx) {
  const { config, positionals, flags } = ctx;
  const sub = positionals[1];

  if (sub === 'export') {
    // key export [--kind data|names]
    const kind = (flags.kind || 'data');
    if (kind !== 'data' && kind !== 'names') {
      throw new AppError('ARGS_MISSING', '--kind must be "data" or "names"');
    }
    const { keyHex } = keyring.exportKey(kind, { dataDir: config.dataDir });
    return makeEnvelope('key', {
      ok: true,
      data: { kind, keyHex, warning: 'plaintext key — store securely, never commit' },
      meta: {},
    });
  }

  if (sub === 'import') {
    // key import --kind X --value <hex>
    const kind = flags.kind;
    const value = flags.value;
    if (!kind || (kind !== 'data' && kind !== 'names')) {
      throw new AppError('ARGS_MISSING', '--kind must be "data" or "names"');
    }
    if (!value) {
      throw new AppError('ARGS_MISSING', '--value <hex> is required for key import');
    }
    const result = keyring.importKey(kind, value, { dataDir: config.dataDir });
    return makeEnvelope('key', {
      ok: true,
      data: { kind: result.kind, path: result.path, imported: true },
      meta: {},
    });
  }

  throw new AppError('ARGS_UNKNOWN_CMD', 'key subcommands: export [--kind data|names] | import --kind X --value <hex>');
}

// ---- rekey command ---------------------------------------------------------

/**
 * Re-encrypt all field-level data under a new key.
 * data kind: objects (name_enc, props_json_enc), facts (body_enc),
 *            interpretations (body_enc), relations (rel_enc).
 * names kind: names.map.enc (the pseudonym map).
 * Runs in a single DB transaction for data; atomic rename for names.
 * Requires --confirm flag and --value <newKeyHex> (or generates a new key).
 */
async function cmdRekey(ctx) {
  const { config, flags } = ctx;
  const kind = flags.kind;

  if (!kind || (kind !== 'data' && kind !== 'names')) {
    throw new AppError('ARGS_MISSING', '--kind must be "data" or "names"');
  }
  if (!flags.confirm) {
    throw new AppError(
      'ARGS_MISSING',
      'rekey is destructive — pass --confirm to proceed. ' +
        'The old key will be printed to stderr as a backup before operation.',
    );
  }

  const oldKey = keyring.resolveKey(kind, { dataDir: config.dataDir });
  // Print old key to stderr as backup BEFORE any changes.
  process.stderr.write(
    `\n[machiavelli] rekey: OLD ${kind}-key (backup before rekey):\n` +
      `  ${oldKey.toString('hex')}\n` +
      `  Store this securely before proceeding.\n\n`,
  );

  // New key: from --value or generate.
  let newKey;
  if (flags.value) {
    const s = String(flags.value).trim();
    newKey = Buffer.from(s, 'hex');
    if (newKey.length !== keyring.KEY_LEN) {
      throw new AppError('KEY_INVALID', `--value must be ${keyring.KEY_LEN * 2} hex chars (${keyring.KEY_LEN} bytes)`);
    }
  } else {
    newKey = require('node:crypto').randomBytes(keyring.KEY_LEN);
    process.stderr.write(
      `[machiavelli] rekey: Generated NEW ${kind}-key:\n` +
        `  ${newKey.toString('hex')}\n\n`,
    );
  }

  // Idempotency: same key -> no-op.
  if (oldKey.equals(newKey)) {
    return makeEnvelope('rekey', {
      ok: true,
      data: { kind, reencrypted: 0, noop: true, reason: 'new key equals old key' },
      meta: {},
    });
  }

  let reencrypted = 0;

  if (kind === 'names') {
    // Re-encrypt the names map blob only.
    const { loadMap, saveMap } = namesMap;
    const map = loadMap(oldKey, config.namesMapPath);
    saveMap(map, newKey, config.namesMapPath);
    reencrypted = Object.keys(map).length;
  } else {
    // kind === 'data': re-encrypt all field-enc columns in one transaction.
    const keys = resolveKeys(config);
    // We use oldKey for decrypt, newKey for re-encrypt.
    const db = openDb(config, keys); // opens with current (old) key
    ctx.db = db;

    const AADs = {
      objects_name: 'objects.name_enc',
      objects_props: 'objects.props_json_enc',
      facts: 'facts.body_enc',
      interpretations: 'interpretations.body_enc',
      relations: 'relations.rel_enc',
    };

    const tx = db.transaction(() => {
      // objects: name_enc + props_json_enc
      const objRows = db.prepare('SELECT id, name_enc, props_json_enc FROM objects').all();
      for (const row of objRows) {
        const updates = {};
        if (row.name_enc) {
          const pt = decrypt(toBuf(row.name_enc), oldKey, AADs.objects_name);
          updates.name_enc = encrypt(pt, newKey, AADs.objects_name);
        }
        if (row.props_json_enc) {
          const pt = decrypt(toBuf(row.props_json_enc), oldKey, AADs.objects_props);
          updates.props_json_enc = encrypt(pt, newKey, AADs.objects_props);
        }
        if (Object.keys(updates).length) {
          db.prepare(
            'UPDATE objects SET name_enc=?, props_json_enc=?, updated_ts=? WHERE id=?',
          ).run(updates.name_enc || row.name_enc, updates.props_json_enc || row.props_json_enc, Date.now(), row.id);
          reencrypted++;
        }
      }

      // facts: body_enc
      const factRows = db.prepare('SELECT id, body_enc FROM facts').all();
      for (const row of factRows) {
        if (!row.body_enc) continue;
        const pt = decrypt(toBuf(row.body_enc), oldKey, AADs.facts);
        const newEnc = encrypt(pt, newKey, AADs.facts);
        db.prepare('UPDATE facts SET body_enc=? WHERE id=?').run(newEnc, row.id);
        reencrypted++;
      }

      // interpretations: body_enc
      const interpRows = db.prepare('SELECT id, body_enc FROM interpretations').all();
      for (const row of interpRows) {
        if (!row.body_enc) continue;
        const pt = decrypt(toBuf(row.body_enc), oldKey, AADs.interpretations);
        const newEnc = encrypt(pt, newKey, AADs.interpretations);
        db.prepare('UPDATE interpretations SET body_enc=? WHERE id=?').run(newEnc, row.id);
        reencrypted++;
      }

      // relations: rel_enc
      const relRows = db.prepare('SELECT id, rel_enc FROM relations').all();
      for (const row of relRows) {
        if (!row.rel_enc) continue;
        const pt = decrypt(toBuf(row.rel_enc), oldKey, AADs.relations);
        const newEnc = encrypt(pt, newKey, AADs.relations);
        db.prepare('UPDATE relations SET rel_enc=? WHERE id=?').run(newEnc, row.id);
        reencrypted++;
      }
    });
    tx();
    // db stays open; close happens in finally block
  }

  // Persist new key to file (overwrite old).
  const keyFilePath = keyring.keyFilePath(kind, config.dataDir);
  require('node:fs').writeFileSync(keyFilePath, newKey, { mode: 0o600 });
  require('node:fs').chmodSync(keyFilePath, 0o600);

  return makeEnvelope('rekey', {
    ok: true,
    data: { kind, reencrypted, keyPath: keyFilePath, newKeyHex: newKey.toString('hex') },
    meta: {},
  });
}

function toBuf(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

// ---- ingest command --------------------------------------------------------

/**
 * Ingest an externally-generated interpretation.
 * Usage: ingest profile <personRef> --lens <lens> --body <text>
 *   or:  ingest profile <personRef> --lens <lens> --stdin  (reads body from stdin)
 * model is set to 'external'. No consent gate (no LLM called by core).
 */
async function cmdIngest(ctx) {
  const { config, positionals, flags } = ctx;
  const sub = positionals[1];

  if (sub !== 'profile') {
    throw new AppError('ARGS_UNKNOWN_CMD', 'ingest subcommands: profile <personRef> --lens <lens> --body <text>|--stdin');
  }

  const personRef = positionals[2];
  if (!personRef) throw new AppError('ARGS_MISSING', 'ingest profile requires <personRef>');

  const lens = flags.lens;
  if (!lens) throw new AppError('ARGS_MISSING', 'ingest profile requires --lens <lens>');

  let body;
  if (flags.stdin) {
    // Read from stdin
    body = await readStdin();
  } else {
    body = flags.body;
    if (!body) throw new AppError('ARGS_MISSING', 'ingest profile requires --body <text> or --stdin');
  }

  if (!body || String(body).trim() === '') {
    throw new AppError('ARGS_MISSING', 'ingest: body must be non-empty');
  }

  const keys = resolveKeys(config);
  const db = openDb(config, keys);
  ctx.db = db;

  const subject = objects.findByRef(db, personRef);
  if (!subject) throw new AppError('PERSON_NOT_FOUND', `person "${personRef}" not found`);

  const saved = interp.saveInterpretation(db, subject.id, lens, String(body).trim(), 'external', []);

  return makeEnvelope('ingest', {
    ok: true,
    data: {
      interpretation_id: saved.id,
      subject: subject.code,
      lens,
      model: 'external',
      created_ts: saved.created_ts,
    },
    meta: {},
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ---- router ----------------------------------------------------------------

const ROUTES = {
  init: cmdInit,
  person: cmdPerson,
  fact: cmdFact,
  profile: cmdProfile,
  advice: (ctx) => cmdAdvice(ctx, false),
  daily: (ctx) => cmdAdvice(ctx, true),
  graph: cmdGraph,
  relation: cmdRelation,
  status: cmdStatus,
  doctor: cmdDoctor,
  version: cmdVersion,
  key: cmdKey,
  rekey: cmdRekey,
  ingest: cmdIngest,
};

async function main() {
  const { positionals, flags } = parse(process.argv.slice(2));
  const cmd = positionals[0];

  if (!cmd || flags.help) {
    process.stderr.write(
      'usage: machiavelli <cmd> [options]\n\n' +
        'Commands:\n' +
        '  init                          Set up ego-centre\n' +
        '  person "<name>"               Add a person\n' +
        '  fact <person> "<fact>"        Append immutable fact\n' +
        '  profile <person>              (Re)generate psycho-profile\n' +
        '    --lens disc,leverage,bigfive  --dry --regen --consent\n' +
        '  advice "<query>"              Get strategic advice\n' +
        '    --dry --consent --as <personRef>\n' +
        '  daily                         Daily digest\n' +
        '    --dry --consent --as <personRef>\n' +
        '  graph [--person X]            Show relation graph\n' +
        '  relation confirm <edge_id>    Confirm a pending edge\n' +
        '  status                        Runtime diagnostics\n' +
        '  doctor                        Status + LLM ping\n' +
        '  version                       Version/contract\n' +
        '  key export [--kind data|names]               Export key hex to stdout\n' +
        '  key import --kind data|names --value <hex>   Import key from hex\n' +
        '  rekey --kind data|names [--value <hex>] --confirm  Re-encrypt all data\n' +
        '  ingest profile <person> --lens <lens> --body <text>|--stdin\n' +
        '\nGlobal flags: --json --model NAME\n',
    );
    process.exitCode = cmd ? 0 : 2;
    return;
  }

  const handler = ROUTES[cmd];
  const config = resolveConfig(flags, process.env);
  const ctx = { positionals, flags, config, db: null };

  try {
    // Env checks (except pure version, which must always work).
    if (cmd !== 'version') {
      checkNode();
      checkDeps();
    }
    if (!handler) throw new AppError('ARGS_UNKNOWN_CMD', `unknown command "${cmd}"`);

    const envelope = await handler(ctx);
    printEnvelope(envelope, flags);
    process.exitCode = 0;
  } catch (err) {
    const appErr = err instanceof AppError ? err : new AppError('INTERNAL', err.message || String(err), { cause: err });
    const envelope = makeEnvelope(cmd, {
      ok: false,
      error: { code: appErr.code, message: appErr.message, retryable: appErr.retryable, details: appErr.details },
      meta: {},
    });
    printEnvelope(envelope, flags);
    if (ENV_ERRORS.has(appErr.code)) process.exitCode = 3;
    else if (ARG_ERRORS.has(appErr.code)) process.exitCode = 2;
    else process.exitCode = 1;
    if (!(err instanceof AppError)) process.stderr.write(`${err.stack}\n`);
  } finally {
    if (ctx.db) {
      try {
        ctx.db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
