import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lintQuestion, lintRequest, extractPaths, resolvePath, lintState,
  estimateTokens, textOf, CTX_TOTAL_TOKENS,
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
  const big = 'x'.repeat(Math.ceil(CTX_TOTAL_TOKENS * 5.5) + 10_000);
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
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return; // copied outside the package layout; nothing of ours to check
  }
  // Copied into a host project, ../../.. is THEIR package.json. Asserting on it
  // would fail their build and blame wellposed's badge for their dependencies.
  if (pkg.name !== 'wellposed') return;
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
      // Scan import STATEMENTS only. Matching bare /from ['"]...['"]/ also hit
      // ordinary prose in comments, e.g. `indistinguishable from "errors found"`.
      const specs = [];
      for (const line of src.split('\n')) {
        // `import ... '<spec>'`, or a re-export / multi-line tail `} from '<spec>'`.
        // `export const X = 'https://...'` must NOT match, hence the `from`.
        const imp = line.match(/^\s*import\b[^'"]*?['"]([^'"]+)['"]/);
        if (imp) specs.push(imp[1]);
        const reexp = line.match(/\bfrom\s*['"]([^'"]+)['"]\s*;?\s*$/);
        if (reexp && /^\s*(?:export|}|\w)/.test(line) && !imp) specs.push(reexp[1]);
        for (const dyn of line.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)) specs.push(dyn[1]);
      }
      for (const spec of specs) {
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

// --- shapes the live API rejects (all verified 2026-09-21) -----------------

test('every request shape the API rejects is caught locally as an error', async () => {
  const { MAX_SCORE_LEVELS } = await import('../scripts/structural.mjs');
  const Q = (q) => ({ model: 'jev-latest', state: 'test', questions: { q } });
  const cases = [
    ['Choice criteria as array (422 dict_type)', Q({ type: 'choice', instructions: 'W?', criteria: ['a', 'b'] })],
    ['Score criteria as object (422 list_type)', Q({ type: 'score', instructions: 'W?', criteria: { lo: 'a', hi: 'b' } })],
    ['Noul criteria {} (400)', Q({ type: 'noul', criteria: {} })],
    ['Choice criteria {} (400)', Q({ type: 'choice', instructions: 'W?', criteria: {} })],
    ['Score over the level cap (400)', Q({ type: 'score', instructions: 'W?', criteria: Array.from({ length: MAX_SCORE_LEVELS + 2 }, (_, i) => `level ${i}`) })],
    ['state null (422)', { model: 'jev-latest', state: null, questions: { q: { type: 'noul', instructions: 'ok?' } } }],
    ['state scalar (422)', { model: 'jev-latest', state: 42, questions: { q: { type: 'noul', instructions: 'ok?' } } }],
    ['empty question key (400)', { model: 'jev-latest', state: 'x', questions: { '': { type: 'noul', instructions: 'ok?' } } }],
  ];
  for (const [label, req] of cases) {
    assert.ok(lintRequest(req).counts.error > 0, `not caught: ${label}`);
  }
});

test('resolvePath only sees own properties and handles dotted keys', () => {
  assert.equal(resolvePath({ ticket: {} }, 'ticket.constructor').found, false);
  assert.equal(resolvePath({ ticket: {} }, 'ticket.toString').found, false);
  assert.equal(resolvePath({}, '__proto__').found, false);
  assert.equal(resolvePath({ 'a.b': 1 }, 'a.b').found, true, 'a literal dotted key must resolve');
  assert.equal(resolvePath({ xs: [{ v: 1 }] }, 'xs[0].v').found, true);
});

test('textOf survives cycles and deep nesting', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => textOf(cyclic));
  let deep = { v: 'leaf' };
  for (let i = 0; i < 500; i++) deep = { next: deep };
  assert.doesNotThrow(() => textOf(deep));
  assert.doesNotThrow(() => lintRequest({ model: 'm', state: 'x', questions: { q: { type: 'noul', instructions: deep } } }));
});

test('token estimate is calibrated and errs on the conservative side', async () => {
  const { estimateTokens, CHARS_PER_TOKEN_TEXT, CHARS_PER_TOKEN_JSON } = await import('../scripts/structural.mjs');
  // Measured against the API's own usage.input_tokens on 2026-09-21.
  const prose = 'The customer reported that the payment failed repeatedly and asked for a refund of the duplicate charge. ';
  const rec = (i) => ({ id: `A-${i}`, status: 'captured', amount_usd: 49, note: 'duplicate charge on the account' });
  for (const [value, actual] of [
    [prose.repeat(20), 361], [prose.repeat(60), 1081],
    [{ records: Array.from({ length: 20 }, (_, i) => rec(i)) }, 855],
    [{ records: Array.from({ length: 60 }, (_, i) => rec(i)) }, 2575],
  ]) {
    const est = estimateTokens(value);
    assert.ok(est >= actual, `must not under-estimate: ${est} < ${actual}`);
    assert.ok(est < actual * 1.25, `must not wildly over-estimate: ${est} vs ${actual}`);
  }
  assert.ok(CHARS_PER_TOKEN_TEXT > CHARS_PER_TOKEN_JSON, 'prose packs more chars per token than JSON');
});

test('a bundled-judgment exemption covers enumerated evidence and quotes', () => {
  const exempt = [
    'Is this ticket urgent? Consider the subject, the body, and whether a deadline is named.',
    'Does the message contain the phrase "please cancel and do not renew"?',
  ];
  for (const instructions of exempt) {
    assert.ok(!rules(lintQuestion('q', { type: 'noul', instructions })).includes('jev/bundled-judgments'),
      `false positive on: "${instructions}"`);
  }
  assert.ok(rules(lintQuestion('q', { type: 'noul', instructions: 'Is the rent within budget and are pets allowed?' }))
    .includes('jev/bundled-judgments'), 'real bundling must still fire');
});

// --- every file argument is linted ----------------------------------------
// `lint a.json b.json` used to lint a.json only and exit on it, so a CI glob of
// thirty files went green having checked one.

test('every positional file is linted and the exit code covers all of them', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = join(here, '..', 'scripts', 'wellposed.mjs');
  const failing = join(here, '..', 'examples', 'support-ticket.json');
  const dir = mkdtempSync(join(tmpdir(), 'wellposed-'));
  const clean = join(dir, 'clean.json');
  writeFileSync(clean, JSON.stringify({ model: 'jev-latest', state: { msg: 'x' },
    questions: { a: { type: 'noul', instructions: 'Does `msg` ask for a refund?' },
                 b: { type: 'noul', instructions: 'Is `msg` about billing?' } } }));
  try {
    const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(run('lint', clean, failing).status, 1, 'an error in the SECOND file must fail the run');
    assert.equal(run('lint', clean, clean).status, 0);
    assert.equal(run('lint', clean, join(dir, 'missing.json')).status, 2, 'a missing file is a usage error');

    const multi = JSON.parse(run('lint', clean, failing, '--json').stdout);
    assert.equal(multi.files.length, 2);
    assert.equal(multi.ok, false);
    assert.deepEqual(multi.files.map((f) => f.ok), [true, false]);

    const single = JSON.parse(run('lint', failing, '--json').stdout);
    assert.deepEqual(Object.keys(single).sort(), ['counts', 'findings', 'ok', 'semantic'],
      'single-file --json must keep its original shape');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Score levels that cross two dimensions --------------------------------

test('crossed dimensions: the same subject re-rated at every level fires', async () => {
  const { crossedDimensions } = await import('../scripts/structural.mjs');
  const crossed = [
    'description is unreadable and the diff has no tests',
    'description is vague and test coverage is thin',
    'description is adequate and coverage is partial',
    'description is clear and most changed paths are tested',
  ];
  assert.equal(crossedDimensions(crossed)?.subject, 'description');
  const f = lintQuestion('s', { type: 'score', instructions: 'Rate this PR.', criteria: crossed });
  assert.equal(sev(f, 'score/crossed-dimensions'), 'warn');
});

test('crossed dimensions: a severity ladder of co-varying clauses stays quiet', async () => {
  const { crossedDimensions } = await import('../scripts/structural.mjs');
  // Two clauses per level, but a different situation at each rung. This is what
  // TypeSafe's docs ask levels to look like, and a keyword rule flags it.
  const ladders = [
    ['nothing is blocked - a question or a cosmetic issue',
     'a task is slower, but the normal path still works',
     'a task is blocked and a documented workaround is available',
     'a core workflow is blocked and the only workaround is manual',
     'the customer cannot operate at all and no workaround exists'],
    ['Minor: a non-critical feature is degraded for some users',
     'Major: a core workflow is broken for many users and the only workaround is slow',
     'Critical: the product is unusable for every user on the account'],
    ['clear and concise', 'mostly clear', 'confusing', 'unreadable'],
    ['can wait weeks', 'should be handled this week', 'needs attention today'],
  ];
  for (const levels of ladders) {
    assert.equal(crossedDimensions(levels), null, `false positive on: ${levels[0]}`);
  }
});

// --- rules prompted by comparing against simota/tenbin ----------------------

test('forbidden paths: key, dotted suffix and full path, silent when unconfigured', async () => {
  const { forbiddenPaths } = await import('../scripts/structural.mjs');
  const state = { customer: { name: 'A', billing: { card_number: '4111' } },
                  records: [{ ssn: '123' }, { note: 'x' }], api_key: 'k' };
  assert.deepEqual(forbiddenPaths(state, undefined), [], 'silent with no list configured');
  assert.deepEqual(forbiddenPaths(state, ['card_number']), ['customer.billing.card_number']);
  assert.deepEqual(forbiddenPaths(state, ['billing.card_number']), ['customer.billing.card_number']);
  assert.deepEqual(forbiddenPaths(state, ['SSN']), ['records[].ssn'], 'case-insensitive, and reaches into arrays');
  assert.deepEqual(forbiddenPaths(state, ['api_key']), ['api_key']);
  assert.deepEqual(forbiddenPaths(state, ['name.card']), [], 'a suffix must match whole segments');
  const r = lintRequest({ model: 'm', state, questions: { q: { type: 'noul', instructions: 'Is `customer.name` set?' } } },
    { forbidden: ['card_number'] });
  assert.equal(sev(r.findings, 'state/forbidden-path'), 'error');
});

test('id-only semantics: a two-word Noul with no criteria leans on a key the model never sees', () => {
  assert.equal(sev(lintQuestion('refund_requested', { type: 'noul', instructions: 'refund?' }), 'question/id-only-semantics'), 'warn');
  assert.ok(!rules(lintQuestion('r', { type: 'noul', instructions: 'Does the customer ask for a refund?' })).includes('question/id-only-semantics'));
  assert.ok(!rules(lintQuestion('r', { type: 'noul', instructions: 'refund?',
    criteria: { true: 'The customer asks for money back.', false: 'No refund is requested.' } })).includes('question/id-only-semantics'),
    'criteria carry the meaning, so a terse instruction is fine');
});

test('criteria-inverted: a negated true is flagged, unless the question is itself negative', () => {
  const inverted = { type: 'noul', instructions: 'Does the customer ask for a refund?',
    criteria: { true: 'No refund is requested.', false: 'The customer asks for their money back.' } };
  assert.equal(sev(lintQuestion('q', inverted), 'noul/criteria-inverted'), 'info');
  const framed = { type: 'noul', instructions: 'Is the record free of personal data?',
    criteria: { true: 'No personal data appears.', false: 'Names, emails or IDs appear.' } };
  assert.ok(!rules(lintQuestion('q', framed)).includes('noul/criteria-inverted'), 'negatively framed question: negated true is correct');
  const normal = { type: 'noul', instructions: 'Does the customer ask for a refund?',
    criteria: { true: 'The customer asks for money back.', false: 'No refund is requested.' } };
  assert.ok(!rules(lintQuestion('q', normal)).includes('noul/criteria-inverted'));
});

test('numeric-only Score levels are flagged; described levels are not', () => {
  for (const criteria of [['1', '2', '3', '4', '5'], ['1-3', '4-6', '7-10'], ['0', '0.5', '1']]) {
    assert.equal(sev(lintQuestion('s', { type: 'score', instructions: 'How urgent?', criteria }), 'score/numeric-only-levels'), 'warn',
      JSON.stringify(criteria));
  }
  for (const criteria of [['can wait weeks', 'needs attention today'], ['1 - can wait', '5 - on fire'], ['low', 'high']]) {
    assert.ok(!rules(lintQuestion('s', { type: 'score', instructions: 'How urgent?', criteria })).includes('score/numeric-only-levels'),
      JSON.stringify(criteria));
  }
});

test('counting inside a Score is advisory, because bucketing is the documented fix', () => {
  const score = { type: 'score', instructions: 'How many bedrooms does this listing advertise?',
                  criteria: ['studio', 'one or two', 'three or more'] };
  assert.equal(sev(lintQuestion('s', score), 'jev/counting'), 'info');
  assert.equal(sev(lintQuestion('n', { type: 'noul', instructions: 'How many bedrooms does this listing advertise?' }), 'jev/counting'), 'warn',
    'an un-bucketed count is still a warning');
});

test('a throwaway uid in state is not reported as unreferenced', () => {
  const f = lintState({ uid: 'run-7:ab12', msg: 'charged twice' }, { q: { type: 'noul', instructions: 'Does `msg` ask for a refund?' } });
  assert.ok(!rules(f).includes('state/unreferenced-fields'), 'the consistency cookbook tells users to add this field');
});

test('the CLI honours a forbidden list and rejects a malformed one', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'wellposed.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'wellposed-'));
  try {
    const req = join(dir, 'r.json');
    writeFileSync(req, JSON.stringify({ model: 'm', state: { msg: 'x', customer: { email: 'a@b.c' } },
      questions: { a: { type: 'noul', instructions: 'Does `msg` ask for a refund?' },
                   b: { type: 'noul', instructions: 'Is `customer` a returning buyer?' } } }));
    const ok = join(dir, 'ok.json'); writeFileSync(ok, JSON.stringify({ forbidden: ['email'] }));
    const bad = join(dir, 'bad.json'); writeFileSync(bad, JSON.stringify({ forbidden: 'email' }));
    const run = (cfg) => spawnSync(process.execPath, [cli, 'lint', req, '--config', cfg], { encoding: 'utf8' }).status;
    assert.equal(run(ok), 1, 'a forbidden field is an error');
    assert.equal(run(bad), 2, 'a non-array forbidden list is a usage error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Choice whose option descriptions are objects is linted, not crashed on', () => {
  // Found in public jev code: {"what": ..., "not_for": ..., "examples": [...]} per option.
  const q = { type: 'choice', instructions: 'What does `visitor` want?',
    criteria: { delivery: { what: 'Dropping something off', examples: ['a parcel'] },
                sales: { what: 'Selling something', not_for: 'Deliveries' } } };
  assert.deepEqual(lintQuestion('intent', q).map((f) => f.rule), ['choice/no-escape-hatch']);
  const hatch = { ...q, criteria: { ...q.criteria, other: { what: 'None of the above' } } };
  assert.equal(lintQuestion('intent', hatch).some((f) => f.rule === 'choice/no-escape-hatch'), false);
});
