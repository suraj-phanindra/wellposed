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

/** Wilson score interval: honest bounds on a proportion from a small sample. */
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
const pct = (x) => `${Math.round(100 * x)}%`;
const ci = (k, n) => { const [lo, hi] = wilson(k, n); return `[${pct(lo)}-${pct(hi)}]`; };

if (argv.includes('--sweep')) {
  // Offline: recompute recall / precision / abstention at other thresholds from
  // a previous --dump. Every row carries pDefect, including the negatives, so a
  // false positive at a lower threshold is actually visible.
  const dumpPath = join(dirname(fileURLToPath(import.meta.url)), 'semantic-raw.json');
  if (!existsSync(dumpPath)) { console.error('\n  no dump; run with --dump first\n'); process.exit(2); }
  const rows = JSON.parse(readFileSync(dumpPath, 'utf8'));
  if (!rows.every((r) => 'pDefect' in r)) {
    console.error('\n  this dump predates pDefect and cannot be swept honestly; re-run with --dump\n');
    process.exit(2);
  }
  const LOW_BAND = 0.35;
  const P = rows.filter((r) => r.has_defect), N = rows.filter((r) => !r.has_defect);
  console.log(`\n  sweep over ${rows.length} items (${P.length} positive, ${N.length} negative), from the last --dump\n`);
  console.log('  ' + 'warn above'.padEnd(12) + 'recall'.padStart(8) + 'precision'.padStart(11) + '  precision 95% CI'.padEnd(20) + 'false alarms'.padStart(13));
  console.log('  ' + '-'.repeat(66));
  for (const th of [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.80]) {
    const fired = (r) => r.pDefect != null && r.pDefect > th;
    const tp = P.filter(fired).length, fp = N.filter(fired).length;
    console.log('  ' + th.toFixed(2).padEnd(12) + `${tp}/${P.length}`.padStart(8)
      + (tp + fp ? `${tp}/${tp + fp}` : '-').padStart(11) + ('  ' + ci(tp, tp + fp)).padEnd(20) + String(fp).padStart(13));
  }
  const band = (r) => r.pDefect != null && r.pDefect >= LOW_BAND && r.pDefect <= 0.50;
  console.log(`\n  in the uncertain band ${LOW_BAND}-0.50 today: ${rows.filter(band).length}/${rows.length} items routed to a human`);
  const negs = N.map((r) => r.pDefect).filter((x) => x != null).sort((a, b) => b - a);
  console.log(`  highest defect probability on any negative: ${negs.length ? negs[0].toFixed(2) : 'n/a'} `
    + `(top five: ${negs.slice(0, 5).map((x) => x.toFixed(2)).join(', ')})\n`);
  process.exit(0);
}

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
  let cells = [];
  try {
    const r = await semanticLint(req, { structuralByQuestion: new Map([[qid, structural]]) });
    findings = r.findings;
    cells = r.raw;
    calls += r.calls;
    usage.input_tokens += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;
  } catch (e) {
    console.error(`  item ${it.id}: ${e.message}`);
    continue;
  }

  const rule = ruleFor(it.defect);
  const hit = findings.find((f) => f.rule === rule);
  // Take the probability from the raw cell, not from `hit`: a finding exists only
  // at or above LOW, so negatives would otherwise all be recorded as null.
  const cell = cells.find((c) => c.rule === rule);
  raw.push({ id: it.id, defect: it.defect, has_defect: it.has_defect,
             asked: Boolean(cell), p: cell?.p ?? null, pDefect: cell?.pDefect ?? null });
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
console.log(`\n  recall    ${T.tp}/${T.tp + T.fn} = ${(100 * rec).toFixed(0)}%  95% CI ${ci(T.tp, T.tp + T.fn)}`);
console.log(`  precision ${T.tp}/${T.tp + T.fp} = ${(100 * pre).toFixed(0)}%  95% CI ${ci(T.tp, T.tp + T.fp)}`);
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
