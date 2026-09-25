// Do overlapping options make jev's answer arbitrary on REAL Choices? Committed before
// any input was generated or any jev call made.
//
// Questions: the real Choices (outcome/overlap-questions.json) that two blind
// reviewers both said have overlapping options, with fully literal text.
// Inputs: a blind generator writes 2 states for which TWO options are both correct
// (naming them) and 2 that fit exactly one; an independent model labels each state
// without seeing the intent, and only states whose label matches are kept.
// Conditions, one question per request, jev-1.13.0: the options in the author's order,
// and the same options in reverse order.
// Pre-registered measures:
//   O1  on both-true states: how often reversing the option order changes jev's answer
//   O2  on single-fit states: the same flip rate (the baseline)
//   O3  on both-true states: mean confidence, and how often jev picks whichever of the
//       two true options is listed first (position bias)
// Reported with Wilson 95% intervals; nothing is dropped after scoring.
//
// usage: node outcome_overlap.mjs run | score
import { readFileSync, writeFileSync } from 'node:fs';
const Q = Object.fromEntries(JSON.parse(readFileSync('outcome/overlap-questions.json', 'utf8')).map((q) => [q.id, q]));
const W = (k, n, z = 1.96) => { if (!n) return '[—]'; const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return `[${Math.round(100 * Math.max(0, c - m))}–${Math.round(100 * Math.min(1, c + m))}%]`; };
const pct = (k, n) => `${k}/${n} = ${n ? Math.round(100 * k / n) : 0}% ${W(k, n)}`;
const reversed = (c) => Object.fromEntries(Object.entries(c).reverse());

async function ask(state, q, criteria) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model: 'jev-1.13.0', questions: { q: { type: 'choice', instructions: q.instructions, criteria } } }),
        signal: AbortSignal.timeout(30000) });
      if (r.ok) { const a = (await r.json()).answers.q; return { choice: a.choice, confidence: a.confidence }; }
      if (attempt >= 3 || (r.status !== 429 && r.status < 500)) return { error: `HTTP ${r.status}` };
    } catch (e) { if (attempt >= 3) return { error: e.message }; }
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
}

if (process.argv[2] === 'run') {
  const inputs = JSON.parse(readFileSync('outcome/overlap-inputs.json', 'utf8'));
  const labels = Object.fromEntries(JSON.parse(readFileSync('outcome/overlap-verify.json', 'utf8')).map((v) => [v.id, v]));
  const same = (s) => { const l = labels[s.id]; if (!l) return false;
    return s.both ? l.label === 'MULTIPLE' && [...s.both].sort().join('|') === [...(l.options ?? [])].sort().join('|') : l.label === s.intended; };
  const kept = inputs.filter(same);
  console.log(`inputs ${inputs.length}, kept after independent check ${kept.length}`);
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < kept.length) { const s = kept[i++]; const q = Q[s.question];
    out.push({ ...s, forward: await ask(s.state, q, q.criteria), reverse: await ask(s.state, q, reversed(q.criteria)) }); } }));
  writeFileSync('outcome/overlap-results.json', JSON.stringify(out));
  console.log(`ran ${out.length} states, errors ${out.filter((o) => o.forward.error || o.reverse.error).length}`);
}

if (process.argv[2] === 'score') {
  const R = JSON.parse(readFileSync('outcome/overlap-results.json', 'utf8')).filter((o) => !o.forward.error && !o.reverse.error);
  const both = R.filter((o) => o.both), single = R.filter((o) => !o.both);
  const flip = (o) => o.forward.choice !== o.reverse.choice;
  console.log(`both-true states: ${both.length} across ${new Set(both.map((o) => o.question)).size} questions`);
  console.log(`  O1 answer changes when options are reversed: ${pct(both.filter(flip).length, both.length)}`);
  console.log(`  O2 baseline, single-fit states: ${pct(single.filter(flip).length, single.length)}`);
  const firstListed = (o, order) => { const keys = Object.keys(order === 'f' ? Q[o.question].criteria : reversed(Q[o.question].criteria)); return o.both.slice().sort((a, b) => keys.indexOf(a) - keys.indexOf(b))[0]; };
  const pos = both.reduce((n, o) => n + (o.forward.choice === firstListed(o, 'f')) + (o.reverse.choice === firstListed(o, 'r')), 0);
  console.log(`  O3 picks the first-listed of the two true options: ${pct(pos, 2 * both.length)}; mean confidence ${(both.reduce((s, o) => s + o.forward.confidence + o.reverse.confidence, 0) / (2 * both.length)).toFixed(2)} (single-fit ${(single.reduce((s, o) => s + o.forward.confidence + o.reverse.confidence, 0) / (2 * single.length)).toFixed(2)})`);
  console.log(`  answers outside the two true options: ${both.filter((o) => !o.both.includes(o.forward.choice) || !o.both.includes(o.reverse.choice)).length}/${both.length}`);
}
