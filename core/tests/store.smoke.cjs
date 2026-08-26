'use strict';

/**
 * Smoke test for the store layer. Standalone: does not depend on any test
 * framework. Uses a tmp dir + ENV-provided keys. Exits non-zero on failure.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');

const cryptoMod = require('../store/crypto.cjs');
const { detectDriver, openStore } = require('../store/db.cjs');
const objects = require('../store/objects.cjs');
const facts = require('../store/facts.cjs');
const interp = require('../store/interpretations.cjs');
const relations = require('../store/relations.cjs');
const namesMap = require('../store/names_map.cjs');

let pass = 0;
function ok(msg) {
  pass++;
  console.log(`  ✓ ${msg}`);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mach-smoke-'));
  const dbPath = path.join(tmp, 'machiavelli.db');
  const mapPath = path.join(tmp, 'names.map.enc');
  const dataKey = crypto.randomBytes(32);
  const namesKey = crypto.randomBytes(32);

  const driver = detectDriver();
  console.log(`Driver detected: ${driver}`);
  assert(driver, 'a sqlite driver must be available');

  console.log('\n[crypto]');
  {
    const blob = cryptoMod.encrypt('hello secret', dataKey, 'objects.name_enc');
    assert(Buffer.isBuffer(blob) && blob[0] === 0x01, 'blob has version byte');
    const back = cryptoMod.decrypt(blob, dataKey, 'objects.name_enc');
    assert.strictEqual(back, 'hello secret');
    ok('roundtrip encrypt/decrypt');

    let threw = false;
    try {
      cryptoMod.decrypt(blob, dataKey, 'facts.body_enc'); // wrong aad
    } catch (e) {
      threw = e.code === 'DECRYPT_FAILED';
    }
    assert(threw, 'wrong AAD must throw DECRYPT_FAILED');
    ok('wrong AAD rejected');

    let threw2 = false;
    try {
      cryptoMod.decrypt(blob, crypto.randomBytes(32), 'objects.name_enc'); // wrong key
    } catch (e) {
      threw2 = e.code === 'DECRYPT_FAILED';
    }
    assert(threw2, 'wrong key must throw DECRYPT_FAILED');
    ok('wrong key rejected');

    const code = cryptoMod.newPseudoCode('person');
    assert(/^person_[0-9a-f]{8}$/.test(code), 'pseudo-code format');
    ok(`pseudo-code format (${code})`);
  }

  console.log('\n[store open + migrate]');
  const db = openStore({ dbPath, dataKey, allowInRepo: true });
  ok(`opened via ${db.driver}`);
  {
    const uv = db.prepare('PRAGMA user_version').get();
    const ver = uv.user_version ?? Object.values(uv)[0];
    assert(Number(ver) >= 1, 'migrations applied');
    ok(`user_version = ${ver}`);
  }

  console.log('\n[objects]');
  const ego = objects.createEgo(db, { name: 'Me', alias: 'me' });
  assert(ego.is_ego === true, 'ego flagged');
  ok(`createEgo -> ${ego.code}`);

  let egoDup = false;
  try {
    objects.createEgo(db, { name: 'Me2' });
  } catch (e) {
    egoDup = e.code === 'STORE_EGO_EXISTS';
  }
  assert(egoDup, 'second ego rejected');
  ok('single-ego invariant enforced');

  const alice = objects.createObject(db, 'person', 'Alice Cooper', { title: 'CFO' }, { alias: 'alice' });
  ok(`createObject person -> ${alice.code}`);

  assert(objects.findByRef(db, alice.id).id === alice.id, 'findByRef by id');
  assert(objects.findByRef(db, alice.code).id === alice.id, 'findByRef by code');
  assert(objects.findByRef(db, 'alice').id === alice.id, 'findByRef by alias');
  assert(objects.findByRef(db, 'Alice Cooper').id === alice.id, 'findByRef by name');
  ok('findByRef resolves id/code/alias/name');

  assert(objects.list(db, { kind: 'person' }).length === 2, 'list persons');
  ok('list by kind');

  console.log('\n[facts]');
  const f1 = facts.addFact(db, alice.id, 'Prefers email over calls', { source: 'observed', confidence: 'high' });
  assert(f1.created === true, 'fact created');
  ok('addFact');

  const f1dup = facts.addFact(db, alice.id, '  prefers   EMAIL over Calls  ');
  assert(f1dup.created === false && f1dup.duplicateOf === f1.fact.id, 'dedup by normalized body');
  ok('dedup returns duplicateOf');

  facts.addFact(db, alice.id, 'Reports to the CEO', { source: 'org chart' });
  const listed = facts.listFacts(db, alice.id);
  assert(listed.length === 2, 'two facts listed');
  assert(listed[0].body === 'Prefers email over calls', 'decrypted body');
  ok('listFacts + decrypt');

  const ts1 = facts.latestFactTs(db, alice.id);
  assert(typeof ts1 === 'number', 'latestFactTs number');
  ok(`latestFactTs = ${ts1}`);

  facts.tombstone(db, f1.fact.id);
  assert(facts.listFacts(db, alice.id).length === 1, 'tombstoned fact hidden');
  ok('tombstone soft-deletes');

  console.log('\n[interpretations]');
  const i1 = interp.saveInterpretation(db, alice.id, 'disc', 'Dominant/Conscientious', 'model-x', [f1.fact.id]);
  assert(i1.is_current === true, 'interp current');
  ok('saveInterpretation');

  const i2 = interp.saveInterpretation(db, alice.id, 'disc', 'Revised: high C', 'model-y');
  const cur = interp.getCurrent(db, alice.id, 'disc');
  assert(cur.id === i2.id && cur.is_current === true, 'newest is current');
  ok('supersede -> single current per lens');

  // stale check: add a newer fact
  const before = interp.isStale(db, alice.id, 'disc');
  facts.addFact(db, alice.id, 'Started a new project Q3', { source: 'update' });
  const after = interp.isStale(db, alice.id, 'disc');
  assert(after === true, 'stale after newer fact');
  ok(`isStale before=${before} afterNewFact=${after}`);

  console.log('\n[relations]');
  const r1 = relations.addRelation(db, alice.id, 'reports_to', ego.id, { origin: 'interp' });
  assert(r1.status === 'pending' && r1.rel === 'reports_to', 'interp edge pending');
  ok('addRelation (interp -> pending)');

  const c1 = relations.confirm(db, r1.id);
  assert(c1.status === 'confirmed', 'confirmed');
  const c2 = relations.confirm(db, r1.id); // idempotent
  assert(c2.status === 'confirmed', 'idempotent confirm');
  ok('confirm idempotent pending->confirmed');

  const confirmedForAlice = relations.listRelations(db, { personId: alice.id, status: 'confirmed' });
  assert(confirmedForAlice.length === 1, 'filtered relations');
  ok('listRelations filter by person+status');

  console.log('\n[names_map]');
  const codeA = namesMap.codeFor('Alice Cooper', namesKey, { mapPath });
  const codeA2 = namesMap.codeFor('Alice Cooper', namesKey, { mapPath }); // stable
  assert(codeA === codeA2, 'stable code for same name');
  assert(namesMap.resolve(codeA, namesKey, { mapPath }) === 'Alice Cooper', 'resolve');
  ok(`codeFor/resolve roundtrip (${codeA})`);

  let namesTamper = false;
  try {
    namesMap.resolve(codeA, crypto.randomBytes(32), { mapPath }); // wrong key
  } catch (e) {
    namesTamper = e.code === 'NAMES_DECRYPT_FAILED';
  }
  assert(namesTamper, 'wrong names-key rejected');
  ok('names map integrity enforced (wrong key rejected)');

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\nALL GREEN — ${pass} assertions passed (driver: ${driver}).`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('\nSMOKE FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
}
