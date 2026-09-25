// Does a missing escape hatch cause wrong answers on REAL Choices? Committed before
// any input was generated or any jev call made.
//
// Questions: the 31 real Choices (outcome/questions.json) that two blind reviewers both
// said need an escape hatch (15 from the fresh sample, 16 from packet 2).
// Inputs: a blind generator writes 2 states that fit NONE of the options and 2 that fit
// exactly one; an independent model labels each state without seeing the intent, and
// only states whose label matches the intent are kept.
// Conditions, one question per request so nothing leaks between them, jev-1.13.0:
//   as-written   the options exactly as the author wrote them
//   with-hatch   the same plus {"other": "None of the listed options fits"}
// Pre-registered measures:
//   H1  on none-fit states, as-written: how often jev answers with confidence >= 0.9
//       (confidently wrong; every as-written answer there is wrong by construction)
//   H2  on none-fit states, with-hatch: how often jev answers "other"
//   H3  on fit states: accuracy as-written vs with-hatch (what the hatch costs)
// Reported with Wilson 95% intervals, per question and per state; nothing is dropped
// after scoring.
//
// usage: node outcome_hatch.mjs run | score
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const Q = Object.fromEntries(JSON.parse(readFileSync('outcome/questions.json', 'utf8')).map((q) => [q.id, q]));
const HATCH = { other: 'None of the listed options fits' };
const W = (k, n, z = 1.96) => { if (!n) return '[—]'; const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return `[${Math.round(100 * Math.max(0, c - m))}–${Math.round(100 * Math.min(1, c + m))}%]`; };
const pct = (k, n) => `${k}/${n} = ${n ? Math.round(100 * k / n) : 0}% ${W(k, n)}`;

async function ask(state, q, criteria) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model: 'jev-1.13.0', questions: { q: { type: 'choice', instructions: q.instructions, criteria } } }),
        signal: AbortSignal.timeout(30000) });
      if (r.ok) { const a = (await r.json()).answers.q; return { choice: a.choice, confidence: a.confidence }; }
      if (attempt >= 3 || (r.status !== 429 && r.status < 500)) return { error: `HTTP ${r.status} ${(await r.text()).slice(0, 120)}` };
    } catch (e) { if (attempt >= 3) return { error: e.message }; }
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
}

if (process.argv[2] === 'run') {
  const inputs = JSON.parse(readFileSync('outcome/inputs.json', 'utf8'));
  const labels = Object.fromEntries(JSON.parse(readFileSync('outcome/verify.json', 'utf8')).map((v) => [v.id, v.label]));
  const kept = inputs.filter((s) => labels[s.id] === (s.intended ?? 'NONE'));
  console.log(`inputs ${inputs.length}, kept after independent check ${kept.length}`);
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < kept.length) { const s = kept[i++]; const q = Q[s.question];
    out.push({ ...s, asWritten: await ask(s.state, q, q.criteria), withHatch: await ask(s.state, q, { ...q.criteria, ...HATCH }) }); } }));
  writeFileSync('outcome/results.json', JSON.stringify(out));
  console.log(`ran ${out.length} states, errors ${out.filter((o) => o.asWritten.error || o.withHatch.error).length}`);
}

if (process.argv[2] === 'score') {
  const R = JSON.parse(readFileSync('outcome/results.json', 'utf8')).filter((o) => !o.asWritten.error && !o.withHatch.error);
  const none = R.filter((o) => !o.intended), fit = R.filter((o) => o.intended);
  const confW = none.filter((o) => o.asWritten.confidence >= 0.9).length;
  console.log(`none-fit states: ${none.length} across ${new Set(none.map((o) => o.question)).size} questions`);
  console.log(`  H1 as-written, confidence >= 0.9 (confidently wrong): ${pct(confW, none.length)}`);
  console.log(`     as-written, confidence >= 0.8: ${pct(none.filter((o) => o.asWritten.confidence >= 0.8).length, none.length)}; mean confidence ${(none.reduce((s, o) => s + o.asWritten.confidence, 0) / none.length).toFixed(2)}`);
  console.log(`  H2 with-hatch, answered "other": ${pct(none.filter((o) => o.withHatch.choice === 'other').length, none.length)}`);
  const qConf = [...new Set(none.map((o) => o.question))].filter((q) => none.some((o) => o.question === q && o.asWritten.confidence >= 0.9));
  console.log(`     questions with at least one confidently wrong answer: ${qConf.length}/${new Set(none.map((o) => o.question)).size}`);
  console.log(`fit states: ${fit.length}`);
  console.log(`  H3 accuracy as-written: ${pct(fit.filter((o) => o.asWritten.choice === o.intended).length, fit.length)}; with-hatch: ${pct(fit.filter((o) => o.withHatch.choice === o.intended).length, fit.length)}; hatch stole ${fit.filter((o) => o.withHatch.choice === 'other').length}`);
}
