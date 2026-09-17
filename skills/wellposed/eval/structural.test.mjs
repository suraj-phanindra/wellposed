import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lintQuestion, lintRequest, extractPaths, resolvePath, lintState,
  estimateTokens, CTX_TOTAL_TOKENS,
} from '../scripts/structural.mjs';

const rules = (fs) => fs.map((f) => f.rule);
const sev = (fs, rule) => fs.find((f) => f.rule === rule)?.severity;

// --- cases reproduced against the live API on 2026-09-17 --------------------
// Each of these three returned 400 or 422 from api.typesafe.ai. They must be
// errors here, or the linter is claiming something the server disproves.

test('missing instructions and criteria is an error (live API: 400)', () => {
  assert.ok(rules(lintQuestion('q', { type: 'noul' })).includes('question/missing-instructions'));
});

test('non-text instructions is an error (live API: 422)', () => {
  assert.ok(rules(lintQuestion('q', { type: 'noul', instructions: 5 })).includes('instructions/wrong-type'));
});

test('noul criteria as an array is an error (live API: 422)', () => {
  const f = lintQuestion('q', { type: 'noul', instructions: 'ok?', criteria: ['a', 'b'] });
  assert.equal(sev(f, 'noul/criteria-not-object'), 'error');
});

// --- the headline rule ------------------------------------------------------

test('Choice without a none-of-the-above option is flagged', () => {
  const f = lintQuestion('route', {
    type: 'choice', instructions: 'Which team?',
    criteria: { billing: null, technical: null, account: null },
  });
  assert.equal(sev(f, 'choice/no-escape-hatch'), 'warn');
});

test('an explicit escape hatch clears the rule', () => {
  for (const hatch of ['other', 'none of the above', 'unknown', 'not stated']) {
    const f = lintQuestion('route', {
      type: 'choice', instructions: 'Which team?',
      criteria: { billing: null, technical: null, [hatch]: 'fits none of the above' },
    });
    assert.ok(!rules(f).includes('choice/no-escape-hatch'), `"${hatch}" should satisfy the rule`);
  }
});

test('a hatch described only in the option description also counts', () => {
  const f = lintQuestion('route', {
    type: 'choice', instructions: 'Which team?',
    criteria: { billing: null, technical: null, misc: 'A request that fits none of the above' },
  });
  assert.ok(!rules(f).includes('choice/no-escape-hatch'));
});

// --- primitive selection ----------------------------------------------------

test('a degree question asked as a Noul is flagged', () => {
  const f = lintQuestion('u', { type: 'noul', instructions: 'How urgent is this ticket?' });
  assert.equal(sev(f, 'noul/degree-question'), 'warn');
});

test('a genuine yes/no Noul is clean', () => {
  const f = lintQuestion('u', { type: 'noul', instructions: 'Does the resume state that the candidate has used Python at work?' });
  assert.deepEqual(f, []);
});

test('a Score needs at least two levels', () => {
  const f = lintQuestion('s', { type: 'score', instructions: 'How severe?', criteria: ['bad'] });
  assert.equal(sev(f, 'score/too-few-levels'), 'error');
});

// --- documented jev-1.13 weak spots ----------------------------------------

test('counting, arithmetic and date comparison are flagged', () => {
  const cases = [
    ['jev/counting', 'How many bedrooms are listed?'],
    ['jev/arithmetic', 'Calculate the average order value.'],
    ['jev/date-comparison', 'Did the payment arrive before the due date?'],
  ];
  for (const [rule, instructions] of cases) {
    assert.ok(rules(lintQuestion('q', { type: 'noul', instructions })).includes(rule), rule);
  }
});

test('bundled judgments are flagged', () => {
  const f = lintQuestion('q', { type: 'noul', instructions: 'Is the rent within budget and are pets allowed?' });
  assert.ok(rules(f).includes('jev/bundled-judgments'));
});

// --- state ------------------------------------------------------------------

test('backticked paths are extracted, prose in backticks is not', () => {
  assert.deepEqual(
    extractPaths('Check `ticket.messages[0].text` and `order.id`, but not `some prose here`'),
    ['ticket.messages[0].text', 'order.id'],
  );
});

test('a path that does not resolve is an error, and names where it broke', () => {
  const state = { ticket: { subject: 'x' } };
  const f = lintState(state, { q: { type: 'noul', instructions: 'Is `ticket.assigned_agent.name` on the team?' } });
  const broken = f.find((x) => x.rule === 'state/broken-path');
  assert.equal(broken.severity, 'error');
  assert.match(broken.message, /ticket\.assigned_agent/);
});

test('a path that resolves produces no finding', () => {
  const state = { ticket: { messages: [{ text: 'hi' }] } };
  const f = lintState(state, { q: { type: 'noul', instructions: 'Does `ticket.messages[0].text` ask for a refund?' } });
  assert.ok(!rules(f).includes('state/broken-path'));
});

test('state fields no question mentions are reported as context rot', () => {
  const state = { ticket: 'help', unrelated_analytics: [1, 2, 3] };
  const f = lintState(state, { q: { type: 'noul', instructions: 'Is `ticket` urgent?' } });
  assert.equal(sev(f, 'state/unreferenced-fields'), 'info');
});

test('a plain-string state skips the path checks entirely', () => {
  const f = lintState('just some text', { q: { type: 'noul', instructions: 'Is `anything.at.all` true?' } });
  assert.ok(!rules(f).includes('state/broken-path'));
});

// --- request level ----------------------------------------------------------

test('a well-formed request is clean apart from the batching hint', () => {
  const r = lintRequest({
    model: 'jev-latest',
    state: { msg: 'I was charged twice.' },
    questions: { refund: { type: 'noul', instructions: 'Does `msg` request a refund?' } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.counts.error, 0);
  assert.deepEqual(rules(r.findings), ['request/single-question']);
});

test('state over the context budget is an error', () => {
  const big = 'x'.repeat(CTX_TOTAL_TOKENS * 4 + 10_000);
  const r = lintRequest({ model: 'jev-latest', state: big, questions: { q: { type: 'noul', instructions: 'ok?' } } });
  assert.ok(rules(r.findings).includes('context/over-total'));
  assert.ok(estimateTokens(big) > CTX_TOTAL_TOKENS);
});

// --- config -----------------------------------------------------------------

test('a rule can be turned off or re-levelled', () => {
  const q = { type: 'choice', instructions: 'Which team?', criteria: { a: null, b: null } };
  assert.ok(!rules(lintQuestion('r', q, { rules: { 'choice/no-escape-hatch': 'off' } })).includes('choice/no-escape-hatch'));
  assert.equal(sev(lintQuestion('r', q, { rules: { 'choice/no-escape-hatch': 'error' } }), 'choice/no-escape-hatch'), 'error');
});

// --- the corpus keeps the linter honest ------------------------------------

test('every corpus item still lints without throwing', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(readFileSync(join(here, 'corpus.json'), 'utf8'));
  assert.equal(corpus.items.length, 40);
  for (const it of corpus.items) {
    assert.doesNotThrow(() => lintQuestion(String(it.id), it.question), `item ${it.id}`);
  }
});

test('the linter catches every no-escape-hatch item in the corpus', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(readFileSync(join(here, 'corpus.json'), 'utf8'));
  const labelled = corpus.items.filter((i) => i.label === 'no-escape-hatch');
  assert.ok(labelled.length >= 8);
  for (const it of labelled) {
    assert.ok(rules(lintQuestion(String(it.id), it.question)).includes('choice/no-escape-hatch'),
      `corpus item ${it.id} (${it.intent}) should be caught`);
  }
});

// --- the README badge is a static label, so back it with a check ------------

test('the package really has zero dependencies, as the badge claims', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  // ../../../ from eval/ is the package root both in this repo and in node_modules/wellposed/
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[field], undefined,
      `${field} is set — the README's "dependencies 0" badge is now a lie. Remove the dependency or fix the badge.`);
  }
});

test('nothing outside node: builtins is imported', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = [join(here, '..', 'scripts'), here];
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/(?:from|import\(?)\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        assert.ok(spec.startsWith('node:') || spec.startsWith('.'),
          `${f} imports "${spec}" — only node: builtins and relative paths are allowed`);
      }
    }
  }
});
