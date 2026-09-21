#!/usr/bin/env node
/**
 * Score the SEMANTIC layer against its corpus.
 *
 * The structural layer has had a scoreboard since day one; the jev-on-jev
 * checks had none, which is how a published claim about them ended up drawn
 * from two data points. This is the missing half.
 *
 * Unlike the structural harness this costs money: one jev request per corpus
 * item (all applicable checks for that item ride in the same request). Run it
 * deliberately, not in a loop.
 *
 *   node semantic-agreement.mjs              # all checks
 *   node semantic-agreement.mjs --check bundled-judgments
 *   node semantic-agreement.mjs --limit 10   # cheap smoke run
 *
 * A check "fires" when it produces a `warn`. Findings in the uncertain band
 * come back as `info` and are reported separately, because routing those to a
 * human is the documented behaviour rather than a verdict.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintQuestion } from '../scripts/structural.mjs';
import { semanticLint, CHECKS } from '../scripts/semantic.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, 'semantic-corpus.json');
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

if (!existsSync(CORPUS)) {
  console.error(`\n  no semantic corpus at ${CORPUS}\n`);
  process.exit(2);
}
if (!process.env.TYPESAFE_API_KEY) {
  console.error('\n  TYPESAFE_API_KEY is not set; this harness makes live jev calls.\n');
  process.exit(2);
}

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
const only = opt('check');
const limit = Number(opt('limit', Infinity));

let items = corpus.items;
if (only) items = items.filter((i) => i.defect === only);
items = items.slice(0, limit);

const ruleFor = (defect) => `semantic/${defect}`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

const stats = new Map();
const bump = (k, field) => {
  if (!stats.has(k)) stats.set(k, { tp: 0, fp: 0, fn: 0, tn: 0, uncertain: 0 });
  stats.get(k)[field]++;
};

const usage = { input_tokens: 0, output_tokens: 0 };
let calls = 0;
const misses = [];
const raw = [];

console.log(`\n  Scoring ${items.length} items against the semantic layer (1 jev call each)\n`);

for (const [n, it] of items.entries()) {
  const qid = `q${it.id}`;
  const req = { model: 'jev-latest', state: it.state, questions: { [qid]: it.question } };
  // escape-hatch-needed only runs when the free structural rule already fired,
  // so the gate has to be reproduced here or that check never gets asked.
  const structural = new Set(
    lintQuestion(qid, it.question).filter((f) => f.severity !== 'info').map((f) => f.rule)
  );

  let findings = [];
  try {
    const r = await semanticLint(req, { structuralByQuestion: new Map([[qid, structural]]) });
    findings = r.findings;
    calls += r.calls;
    usage.input_tokens += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;
  } catch (e) {
    console.error(`  item ${it.id}: ${e.message}`);
    continue;
  }

  const rule = ruleFor(it.defect);
  const hit = findings.find((f) => f.rule === rule);
  raw.push({ id: it.id, defect: it.defect, has_defect: it.has_defect, p: hit?.probability ?? null });
  const fired = hit?.severity === 'warn';
  const uncertain = hit?.severity === 'info';

  if (uncertain) bump(it.defect, 'uncertain');
  if (it.has_defect && fired) bump(it.defect, 'tp');
  else if (it.has_defect && !fired) { bump(it.defect, 'fn'); misses.push(['MISS', it, hit]); }
  else if (!it.has_defect && fired) { bump(it.defect, 'fp'); misses.push(['FALSE ALARM', it, hit]); }
  else bump(it.defect, 'tn');

  if ((n + 1) % 10 === 0) process.stderr.write(`  …${n + 1}/${items.length}\n`);
}

console.log('  ' + pad('check', 30) + lpad('n', 4) + lpad('recall', 9) + lpad('precision', 11) + lpad('unsure', 8));
console.log('  ' + '-'.repeat(62));
let T = { tp: 0, fp: 0, fn: 0, tn: 0, uncertain: 0 };
for (const [check, s] of [...stats.entries()].sort()) {
  for (const k of Object.keys(T)) T[k] += s[k];
  const n = s.tp + s.fp + s.fn + s.tn;
  const rec = s.tp + s.fn ? s.tp / (s.tp + s.fn) : null;
  const pre = s.tp + s.fp ? s.tp / (s.tp + s.fp) : null;
  console.log('  ' + pad(check, 30) + lpad(n, 4)
    + lpad(rec == null ? '—' : `${s.tp}/${s.tp + s.fn}`, 9)
    + lpad(pre == null ? '—' : `${s.tp}/${s.tp + s.fp}`, 11)
    + lpad(s.uncertain, 8));
}
console.log('  ' + '-'.repeat(62));
const rec = T.tp + T.fn ? T.tp / (T.tp + T.fn) : 0;
const pre = T.tp + T.fp ? T.tp / (T.tp + T.fp) : 0;
console.log(`\n  recall    ${T.tp}/${T.tp + T.fn} = ${(100 * rec).toFixed(0)}%`);
console.log(`  precision ${T.tp}/${T.tp + T.fp} = ${(100 * pre).toFixed(0)}%`);
console.log(`  cost      ${calls} calls, ${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out`);

if (misses.length) {
  console.log(`\n  ${misses.length} disagreement${misses.length > 1 ? 's' : ''}:`);
  for (const [kind, it, hit] of misses.slice(0, 12)) {
    console.log(`    ${kind.padEnd(12)} #${it.id} [${it.defect}] ${it.intent.slice(0, 44)}`);
    console.log(`                 ${(it.question.instructions || '').slice(0, 76)}`);
    if (hit) console.log(`                 jev p=${hit.probability?.toFixed(2)} (${hit.severity})`);
  }
  if (misses.length > 12) console.log(`    … and ${misses.length - 12} more`);
}
if (argv.includes('--dump')) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(here, 'semantic-raw.json'), JSON.stringify(raw, null, 2));
  console.log(`  raw probabilities written to eval/semantic-raw.json (${raw.length} rows)`);
}
console.log();
