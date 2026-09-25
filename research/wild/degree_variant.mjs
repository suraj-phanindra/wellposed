// Score a candidate wording for semantic/degree-as-noul the way production runs it:
// through semanticLint, all checks batched, with only this check's text swapped.
// Sets: the labelled corpus degree items, and the 81 wild Nouls from review2 (tuning).
// usage: node degree_variant.mjs <variant.json | baseline> [--set corpus|wild|holdout]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CHECKS, semanticLint } from '../../skills/wellposed/scripts/semantic.mjs';
import { lintQuestion } from '../../skills/wellposed/scripts/structural.mjs';

const [variantArg, , setArg = 'wild'] = process.argv.slice(2);
const check = CHECKS.find((c) => c.id === 'semantic/degree-as-noul');
if (variantArg !== 'baseline') Object.assign(check, JSON.parse(readFileSync(variantArg, 'utf8')));

function items(set) {
  if (set === 'corpus') {
    const c = JSON.parse(readFileSync('../../skills/wellposed/eval/semantic-corpus.json', 'utf8'));
    return c.items.filter((i) => i.defect === 'degree-as-noul' && i.question.type === 'noul')
      .map((i) => ({ id: `corpus-${i.id}`, q: i.question, state: i.state, label: i.has_defect ? 'present' : 'absent' }));
  }
  const dir = set === 'wild' ? 'review2' : 'degree';
  const pk = JSON.parse(readFileSync(`${dir}/packet.json`, 'utf8')).items.filter((p) => p.check === 'G');
  const lab = (f) => existsSync(`${dir}/${f}`) ? Object.fromEntries(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')).map((v) => [v.id, v.verdict])) : {};
  const a = lab('verdicts-a.json'), b = lab('verdicts-b.json');
  return pk.map((p) => ({ id: p.id, q: { type: 'noul', instructions: p.instructions, ...(p.criteria ? { criteria: p.criteria } : {}) },
    state: null, label: a[p.id] && a[p.id] === b[p.id] && a[p.id] !== 'unclear' ? a[p.id] : 'split' }));
}
const set = items(setArg);
const out = []; let i = 0, calls = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (i < set.length) { const it = set[i++];
  const res = await semanticLint({ state: it.state, model: 'jev-1.13.0', questions: { q: it.q } },
    { model: 'jev-1.13.0', structuralByQuestion: new Map([['q', new Set(lintQuestion('q', it.q).map((f) => f.rule))]]) });
  calls += res.calls;
  out.push({ ...it, p: res.raw.find((c) => c.rule === 'semantic/degree-as-noul')?.pDefect ?? null }); } }));
const tag = variantArg === 'baseline' ? 'baseline' : variantArg.replace(/\.json$/, '').split('/').pop();
writeFileSync(`degree/scores-${tag}-${setArg}.json`, JSON.stringify(out));
const pos = out.filter((o) => o.label === 'present'), neg = out.filter((o) => o.label === 'absent');
const fired = (o) => o.p != null && o.p > 0.5;
console.log(`${tag} on ${setArg}: ${calls} calls | positives caught ${pos.filter(fired).length}/${pos.length} | negatives flagged ${neg.filter(fired).length}/${neg.length} | split/unclear flagged ${out.filter((o) => o.label === 'split' && fired(o)).length}/${out.filter((o) => o.label === 'split').length}`);
for (const o of out.filter((o) => (o.label === 'present') !== fired(o) && o.label !== 'split')) console.log(`   ${o.label === 'present' ? 'MISSED' : 'FALSE '} ${o.p?.toFixed(2)} ${String(typeof o.q.instructions === 'string' ? o.q.instructions : JSON.stringify(o.q.instructions)).slice(0, 110)}`);
