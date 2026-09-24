// Score the linter against blind reviewer labels. A reviewer label counts only when
// both reviewers agree ("consensus"); disagreements and "unclear" are reported, not dropped silently.
import { readFileSync, existsSync } from 'node:fs';
const wilson = (k, n, z = 1.96) => {
  if (!n) return '[—]';
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return `[${Math.round(100 * Math.max(0, c - m))}–${Math.round(100 * Math.min(1, c + m))}%]`;
};
const pct = (k, n) => n ? `${k}/${n} ${String(Math.round(100 * k / n)).padStart(3)}% ${wilson(k, n)}` : '—';
function load(dir) {
  const key = JSON.parse(readFileSync(`${dir}/key.json`, 'utf8'));
  const v = (f) => existsSync(`${dir}/${f}`) ? Object.fromEntries(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')).map((x) => [x.id, x.verdict])) : null;
  return { key, a: v('verdicts-a.json'), b: v('verdicts-b.json') };
}
function kappa(pairs) {   // Cohen's kappa on present/absent pairs
  const n = pairs.length; if (!n) return NaN;
  const po = pairs.filter(([x, y]) => x === y).length / n;
  const pa = pairs.filter(([x]) => x === 'present').length / n, pb = pairs.filter(([, y]) => y === 'present').length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb); return (po - pe) / (1 - pe);
}
function score(dir, linterSays) {
  const { key, a, b } = load(dir);
  if (!a || !b) { console.log(`${dir}: waiting for verdicts (${a ? 'a' : '-'}${b ? 'b' : '-'})`); return; }
  console.log(`\n== ${dir}: ${key.length} items`);
  console.log('  ' + 'rule'.padEnd(32) + 'linter-flagged: consensus defect'.padEnd(38) + 'unflagged: consensus defect'.padEnd(32) + 'split/unclear  kappa');
  for (const rule of [...new Set(key.map((k) => k.rule))]) {
    const ks = key.filter((k) => k.rule === rule);
    const cons = (k) => a[k.id] === b[k.id] && a[k.id] !== 'unclear' ? a[k.id] : null;
    const fl = ks.filter(linterSays), un = ks.filter((k) => !linterSays(k));
    const flC = fl.filter(cons), unC = un.filter(cons);
    const split = ks.filter((k) => !cons(k)).length;
    const pairs = ks.filter((k) => a[k.id] !== 'unclear' && b[k.id] !== 'unclear').map((k) => [a[k.id], b[k.id]]);
    console.log('  ' + rule.padEnd(32) + pct(flC.filter((k) => cons(k) === 'present').length, flC.length).padEnd(38)
      + pct(unC.filter((k) => cons(k) === 'present').length, unC.length).padEnd(32) + `${split}/${ks.length}`.padEnd(15) + kappa(pairs).toFixed(2));
  }
}
score('review', (k) => k.flagged);
score('review2', (k) => k.pDefect > 0.5);
