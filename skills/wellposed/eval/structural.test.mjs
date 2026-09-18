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
  assert.ok(corpus.items.length >= 40, 'corpus must not shrink');
  assert.equal(new Set(corpus.items.map((i) => i.id)).size, corpus.items.length, 'ids must be unique');
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

// --- the rules listing must not be able to drift ---------------------------

test('RULES registry exactly matches the ids the engine can emit', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const { RULES } = await import('../scripts/structural.mjs');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'structural.mjs'), 'utf8');
  const emitted = new Set();
  for (const m of src.matchAll(/finding\('([a-z/-]+)',\s*'(?:error|warn|info)'/g)) emitted.add(m[1]);
  for (const m of src.matchAll(/\[RE_\w+,\s*'([a-z/-]+)'/g)) emitted.add(m[1]);
  const registered = new Set(Object.keys(RULES));
  const missing = [...emitted].filter((r) => !registered.has(r));
  const extra = [...registered].filter((r) => !emitted.has(r));
  assert.deepEqual(missing, [], `emitted but not in RULES — \`wellposed rules\` would under-report: ${missing}`);
  assert.deepEqual(extra, [], `in RULES but never emitted — \`wellposed rules\` would over-report: ${extra}`);
});

// --- regressions from the 2026-09-18 adversarial audit ---------------------
// Each of these was a real false positive on ordinary business English.

test('framed rules do not fire on ordinary prose that merely mentions them', () => {
  const clean = [
    'Does the listing mention after-hours maintenance?',
    'Did the agent respond before anyone escalated?',
    'Did the customer not receive the invoice?',
    'Is the appliance not installed yet?',
    'Did the lead say they are not interested?',
    'Does the customer dispute the number of items delivered?',
    'Does the review mention an average wait time?',
    'Is the rate the tenant pays fixed?',
    'Does the invoice mention how much tax was charged?',
    'Does the customer ask how much the refund will be?',
    'Does the invoice list compute charges separately?',
  ];
  for (const instructions of clean) {
    const f = lintQuestion('q', { type: 'noul', instructions }).filter((x) => x.severity !== 'info');
    assert.deepEqual(f.map((x) => x.rule), [], `false positive on: "${instructions}"`);
  }
});

test('framed rules still catch the real thing', () => {
  const cases = [
    ['jev/counting', 'How many bedrooms does this listing advertise?'],
    ['jev/arithmetic', 'Calculate the total of all charges.'],
    ['jev/date-comparison', 'Did the payment arrive before the due date?'],
    ['jev/date-comparison', 'Was the invoice issued within the last 30 days?'],
    ['jev/double-negative', 'Is the tenant not unwilling to sign?'],
    ['noul/degree-question', 'How severe is this policy violation?'],
    ['noul/degree-question', 'On a scale of 1-10, how risky is this clause?'],
  ];
  for (const [rule, instructions] of cases) {
    assert.ok(rules(lintQuestion('q', { type: 'noul', instructions })).includes(rule),
      `missed ${rule} on: "${instructions}"`);
  }
});

test('escape hatches are recognised in every common spelling', async () => {
  const { normalizeOption } = await import('../scripts/structural.mjs');
  assert.equal(normalizeOption('none_of_the_above'), 'none of the above');
  assert.equal(normalizeOption('notStated'), 'not stated');
  assert.equal(normalizeOption('None of the above.'), 'none of the above');
  assert.equal(normalizeOption('other (please specify)'), 'other');
  for (const hatch of ['none_of_the_above', 'not_stated', 'unspecified', 'notStated',
                       'None of the above.', 'other (please specify)', 'n/a', 'not applicable']) {
    const f = lintQuestion('q', { type: 'choice', instructions: 'Which team?',
      criteria: { billing: null, technical: null, [hatch]: null } });
    assert.ok(!rules(f).includes('choice/no-escape-hatch'), `"${hatch}" should count as an escape hatch`);
  }
});

test('a backticked option name is not treated as a broken state path', () => {
  const q = { type: 'choice',
    instructions: 'Route this to `billing`, `technical`, or `other` if none apply.',
    criteria: { billing: null, technical: null, other: 'Fits none of the above.' } };
  const r = lintRequest({ model: 'jev-latest', state: { ticket: { text: 'x' } }, questions: { team: q } });
  assert.equal(r.counts.error, 0, 'must not error on a request the live API answers at confidence 1.00');
  assert.ok(!rules(r.findings).includes('state/broken-path'));
});

test('a genuinely broken dotted path is still an error', () => {
  const r = lintRequest({ model: 'jev-latest', state: { ticket: {} },
    questions: { q: { type: 'noul', instructions: 'Is `ticket.assigned_agent.name` on the team?' } } });
  assert.ok(rules(r.findings).includes('state/broken-path'));
  assert.equal(r.counts.error, 1);
});

// --- CI gates must fail closed ---------------------------------------------

test('the CLI exits correctly on every gate path', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = join(here, '..', 'scripts', 'wellposed.mjs');
  const ex = join(here, '..', 'examples', 'support-ticket.json');
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8' }).status;
  assert.equal(run('lint', ex), 1, 'a request with an error exits 1');
  assert.equal(run('lint', ex, '--max-warnings=0'), 1, '--flag=value form must be honoured');
  assert.equal(run('lint', ex, '--max-warnings', 'abc'), 2, 'a non-numeric threshold must not silently disable the gate');
  assert.equal(run('lint', ex, '--maxwarnings', '0'), 2, 'an unknown flag must not be silently ignored');
});
