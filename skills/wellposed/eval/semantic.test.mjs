import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semanticLint, settleEscapeHatch, CHECKS, HIGH, LOW } from '../scripts/semantic.mjs';

// A stub that answers every asked check with a fixed noul, so these run offline.
function stubFetch(pFor) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: 'noul', noul: pFor(id) };
    return {
      ok: true, status: 200,
      json: async () => ({ answers, usage: { input_tokens: 1, output_tokens: 1 } }),
      text: async () => '',
    };
  };
}
const req = {
  model: 'jev-latest', state: { msg: 'I was charged twice.' },
  questions: { q: { type: 'noul', instructions: 'Does `msg` ask for a refund?' } },
};

test('every answered check is returned in raw, including ones with no finding', async () => {
  // defectWhen:true checks get a low p (no defect); defectWhen:false get a high p
  // (also no defect). Nothing should fire, and raw must still hold every cell.
  const byId = Object.fromEntries(CHECKS.map((c) => [c.id, c.defectWhen ? 0.05 : 0.95]));
  const r = await semanticLint(req, { apiKey: 'test', fetchImpl: stubFetch((id) => byId[id]) });
  assert.equal(r.findings.length, 0, 'nothing should fire');
  assert.ok(r.raw.length > 0, 'raw must record checks that produced no finding');
  for (const cell of r.raw) {
    assert.equal(typeof cell.pDefect, 'number');
    assert.ok(cell.pDefect < LOW, `${cell.rule}: expected a confident no-defect, got ${cell.pDefect}`);
  }
});

test('pDefect inverts for checks where "no" is the defect', async () => {
  const inverted = CHECKS.find((c) => c.defectWhen === false && c.applies.includes('noul'));
  assert.ok(inverted, 'expected at least one defectWhen:false check for noul');
  const r = await semanticLint(req, { apiKey: 'test', fetchImpl: stubFetch(() => 0.9) });
  const cell = r.raw.find((c) => c.rule === inverted.id);
  assert.equal(cell.p, 0.9);
  assert.ok(Math.abs(cell.pDefect - 0.1) < 1e-9, `pDefect should be 1 - p, got ${cell.pDefect}`);
});

test('bands are exclusive above HIGH and inclusive at LOW', async () => {
  const direct = CHECKS.find((c) => c.defectWhen === true && c.applies.includes('noul'));
  const at = (p) => semanticLint(req, { apiKey: 'test', fetchImpl: stubFetch((id) => (id === direct.id ? p : 0)) })
    .then((r) => r.findings.find((f) => f.rule === direct.id)?.severity ?? 'silent');
  assert.equal(await at(HIGH + 0.01), 'warn');
  assert.equal(await at(HIGH), 'info', 'exactly HIGH is uncertain, not a warning');
  assert.equal(await at(LOW), 'info', 'exactly LOW is uncertain');
  assert.equal(await at(LOW - 0.01), 'silent');
});

// --- the split of criteria-contradict-instructions ------------------------

test('checks that cannot apply are not asked, so they are neither billed nor able to fire', async () => {
  const { buildReviewRequest } = await import('../scripts/semantic.mjs');
  const ids = (q) => buildReviewRequest('q', q, { state: 'x' }).checks.map((c) => c.id);
  const bare = ids({ type: 'noul', instructions: 'Does the customer ask for a refund?' });
  assert.ok(!bare.includes('semantic/criteria-polarity-inverted'), 'no criteria, no polarity check');
  assert.ok(!bare.includes('semantic/criteria-off-topic'), 'no criteria, no off-topic check');
  const withCrit = ids({ type: 'noul', instructions: 'Refund?', criteria: { true: 'asks for money back', false: 'does not' } });
  assert.ok(withCrit.includes('semantic/criteria-polarity-inverted') && withCrit.includes('semantic/criteria-off-topic'));
  assert.ok(!withCrit.includes('semantic/levels-reversed'), 'direction only applies to a Score');
  const score = ids({ type: 'score', instructions: 'Rate it, lowest first.', criteria: ['low', 'high'] });
  assert.ok(score.includes('semantic/levels-reversed') && !score.includes('semantic/criteria-polarity-inverted'));
});

test('the retired id still works in a config and expands to the checks it became', async () => {
  const { expandAliases, ALIASES } = await import('../scripts/semantic.mjs');
  const old = 'semantic/criteria-contradict-instructions';
  const out = expandAliases({ [old]: 'off', 'semantic/levels-reversed': 'warn' });
  assert.ok(!(old in out));
  for (const id of ALIASES[old]) assert.ok(id in out, id);
  assert.equal(out['semantic/criteria-off-topic'], 'off');
  assert.equal(out['semantic/levels-reversed'], 'warn', 'an explicit setting beats the alias');
});

test('a jumbled scale keeps its levels-unordered warning even when levels-reversed also fires', async () => {
  // Held-out #28: levels-reversed misfired on a jumbled scale. Suppressing
  // levels-unordered there would hide the correct diagnosis.
  const q = { model: 'm', state: 'x', questions: { s: { type: 'score', instructions: 'Rate impact, smallest first.', criteria: ['medium', 'tiny', 'huge', 'small'] } } };
  const r = await semanticLint(q, { apiKey: 'test', fetchImpl: stubFetch((id) =>
    id === 'semantic/levels-reversed' ? 0.9 : id === 'semantic/levels-unordered' ? 0.1 : id.includes('bundled') || id.includes('unanswerable') ? 0.95 : 0.05) });
  const rules = r.findings.map((f) => f.rule);
  assert.ok(rules.includes('semantic/levels-reversed'));
  assert.ok(rules.includes('semantic/levels-unordered'), 'the correct diagnosis must not be suppressed');
});

test('the served model is reported, so results can be tied to a version', async () => {
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body); const answers = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: 'noul', noul: 0.05 };
    return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }), text: async () => '' };
  };
  const r = await semanticLint(req, { apiKey: 'test', fetchImpl });
  assert.deepEqual(r.models, ['jev-1.13.0']);
});

test('a thrown network error is retried, and reported cleanly if it persists', async () => {
  const blip = (failures) => { let n = 0; const ok = stubFetch(() => 0.1);
    return async (u, init) => { if (n++ < failures) { const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }; throw e; } return ok(u, init); }; };
  const r = await semanticLint(req, { apiKey: 'test', fetchImpl: blip(1) });
  assert.equal(r.calls, 1, 'one billed call after one retried blip');
  await assert.rejects(semanticLint(req, { apiKey: 'test', fetchImpl: blip(99), maxRetries: 1 }),
    (e) => e.code === 'SEMANTIC_NETWORK' && /UND_ERR_CONNECT_TIMEOUT/.test(e.message));
});

test('jev-on-jev settles the structural escape-hatch warning', () => {
  const warn = (questionId) => ({ rule: 'choice/no-escape-hatch', severity: 'warn', message: 'no hatch.', questionId });
  const raw = [{ questionId: 'exhaustive', rule: 'semantic/escape-hatch-needed', pDefect: 0.42 },
               { questionId: 'needs', rule: 'semantic/escape-hatch-needed', pDefect: 0.81 }];
  const out = settleEscapeHatch([warn('exhaustive'), warn('needs'), warn('not_asked')], raw);
  assert.deepEqual(out.map((f) => f.severity), ['info', 'warn', 'warn']);
  assert.match(out[0].message, /exhaustive \(P=0\.42\)/);
});
