#!/usr/bin/env node
/**
 * Does the structural linter agree with the hand labels?
 *
 * This is the honest scoreboard for Layer 2. It reports, per defect class,
 * how many hand-labelled defects the zero-cost structural rules actually
 * catch — and how many clean questions they wrongly flag. A linter that
 * cries wolf is worse than none, so precision is reported, not hidden.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintQuestion } from '../scripts/structural.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, 'corpus.json'), 'utf8'));

// Which structural rule is meant to catch which hand-labelled defect.
const CATCHES = {
  'no-escape-hatch': ['choice/no-escape-hatch'],
  'degree-as-noul': ['noul/degree-question'],
  'bundled-judgments': ['jev/bundled-judgments'],
  'non-concrete-score-levels': ['score/bare-levels'],
  // Deliberately NOT claimed by structural rules — these need Layer 3.
  'overlapping-choice-options': [],
  'unanswerable-from-state': [],
  'syntax-or-type-error': ['*'],
};

const rows = corpus.items.map((it) => {
  const findings = lintQuestion(String(it.id), it.question);
  const rules = new Set(findings.filter((f) => f.severity !== 'info').map((f) => f.rule));
  const expected = CATCHES[it.label] ?? [];
  const caught = expected.length > 0 && expected.some((r) => rules.has(r));
  return { ...it, rules: [...rules], caught, findings };
});

const byLabel = {};
for (const r of rows) {
  const k = r.defect_code ? r.label : 'well-posed';
  (byLabel[k] ??= []).push(r);
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`\n  Structural lint vs. hand labels  (n=${rows.length})\n`);
console.log('  ' + pad('hand label', 30) + lpad('n', 3) + lpad('caught', 9) + '  note');
console.log('  ' + '-'.repeat(74));
let tp = 0, fn = 0;
for (const [label, items] of Object.entries(byLabel).sort()) {
  if (label === 'well-posed') continue;
  const c = items.filter((i) => i.caught).length;
  tp += c; fn += items.length - c;
  const claimed = (CATCHES[label] ?? []).length > 0;
  console.log('  ' + pad(label, 30) + lpad(items.length, 3) + lpad(`${c}/${items.length}`, 9) + '  ' +
    (claimed ? (c === items.length ? 'fully covered' : 'partial') : 'deferred to the semantic layer'));
}

// False positives: clean questions that nonetheless drew a warn/error.
const clean = byLabel['well-posed'] ?? [];
const fp = clean.filter((r) => r.rules.length > 0);
console.log('  ' + '-'.repeat(74));
console.log('  ' + pad('well-posed (clean)', 30) + lpad(clean.length, 3) + lpad(`${fp.length} flagged`, 10) + '  ' +
  (fp.length ? 'premise does not hold — see below' : 'no false positives'));

const recall = tp / (tp + fn);
const precision = (tp + fp.length) ? tp / (tp + fp.length) : 1;
console.log(`\n  recall    ${tp}/${tp + fn} hand-labelled defects caught = ${(100 * recall).toFixed(0)}%`);
console.log(`  precision ${tp}/${tp + fp.length} flagged questions truly defective = ${(100 * precision).toFixed(0)}%`);

if (fp.length) {
  console.log('\n  False positives:');
  for (const r of fp) {
    console.log(`    #${r.id} ${r.intent}`);
    for (const f of r.findings.filter((x) => x.severity !== 'info')) {
      console.log(`        [${f.rule}] ${f.message.slice(0, 92)}`);
    }
  }
}
console.log();
