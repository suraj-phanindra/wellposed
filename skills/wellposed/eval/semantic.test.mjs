import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semanticLint, CHECKS, HIGH, LOW } from '../scripts/semantic.mjs';

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
