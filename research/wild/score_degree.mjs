// Score the pre-registered degree held-out (build_degree_holdout.mjs): both wordings,
// per stratum, against the consensus of two blind reviewers.
import { readFileSync } from 'node:fs';
const W = (k, n, z = 1.96) => { if (!n) return '[—]'; const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return `[${Math.round(100 * Math.max(0, c - m))}–${Math.round(100 * Math.min(1, c + m))}%]`; };
const key = Object.fromEntries(JSON.parse(readFileSync('degree/key.json', 'utf8')).map((k) => [k.id, k]));
const v = (f) => Object.fromEntries(JSON.parse(readFileSync(`degree/${f}`, 'utf8')).map((x) => [x.id, x.verdict]));
const a = v('verdicts-a.json'), b = v('verdicts-b.json');
const label = (id) => (a[id] === b[id] && a[id] !== 'unclear' ? a[id] : 'split');
const ids = Object.keys(key);
const agree = ids.filter((id) => a[id] !== 'unclear' && b[id] !== 'unclear');
console.log(`reviewers: A ${JSON.stringify(Object.values(a).reduce((o, x) => (o[x] = (o[x] ?? 0) + 1, o), {}))}, B ${JSON.stringify(Object.values(b).reduce((o, x) => (o[x] = (o[x] ?? 0) + 1, o), {}))}, agree on ${agree.filter((id) => a[id] === b[id]).length}/${agree.length} decided pairs`);
for (const tag of ['baseline', 'v2']) {
  const p = Object.fromEntries(JSON.parse(readFileSync(`degree/scores-${tag}-holdout.json`, 'utf8')).map((o) => [o.id, o.p]));
  for (const st of ['G', 'R', 'all']) {
    const S = ids.filter((id) => st === 'all' || key[id].stratum === st);
    const pos = S.filter((id) => label(id) === 'present'), neg = S.filter((id) => label(id) === 'absent'), fired = S.filter((id) => p[id] > 0.5);
    const tp = pos.filter((id) => p[id] > 0.5).length, fp = neg.filter((id) => p[id] > 0.5).length;
    console.log(`  ${tag.padEnd(8)} ${st.padEnd(3)} n=${S.length} fired ${fired.length} | recall ${tp}/${pos.length} ${W(tp, pos.length)} | clean flagged ${fp}/${neg.length} ${W(fp, neg.length)} | precision ${tp}/${tp + fp} ${W(tp, tp + fp)} | fired on split ${fired.filter((id) => label(id) === 'split').length}`);
  }
}
