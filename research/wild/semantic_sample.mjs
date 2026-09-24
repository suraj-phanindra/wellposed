// Semantic layer on wild questions, pinned to jev-1.13.0. One question per repo (seeded
// shuffle) plus every escape-hatch item in the blind review, so the two can be compared.
// No state: wild code builds it at runtime, so unanswerable-from-state never runs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lintQuestion } from '../../skills/wellposed/scripts/structural.mjs';
import { semanticLint } from '../../skills/wellposed/scripts/semantic.mjs';

const N = Number(process.argv[2] ?? 150);
const P = JSON.parse(readFileSync('primary.json', 'utf8'));
const key = JSON.parse(readFileSync('review/key.json', 'utf8'));
const clean = (v) => v && typeof v === 'object' && !Array.isArray(v) && '__template__' in v ? v.__template__
  : Array.isArray(v) ? v.map(clean) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v;
const literal = (r) => r.instrLit && (r.criteria == null || r.critLit);
const h = (s) => createHash('sha1').update('wild-semantic-1' + s).digest('hex');
const seen = new Set();
const sample = P.filter(literal).sort((a, b) => h(a.hash + a.repo).localeCompare(h(b.hash + b.repo)))
  .filter((r) => !seen.has(r.repo) && seen.add(r.repo)).slice(0, N).map((r) => ({ ...r, set: 'sample' }));
const reviewE = key.filter((k) => k.id.startsWith('E'));
for (const k of reviewE) {
  const r = P.find((x) => x.repo === k.repo && x.file === k.file && x.findings.includes('choice/no-escape-hatch') === k.flagged && x.type === 'choice');
  if (r && literal(r)) sample.push({ ...r, set: 'review', reviewId: k.id });
}
const OUT = 'semantic-results.json';
const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const doneKeys = new Set(done.map((d) => d.set + d.hash + d.repo));
const todo = sample.filter((r) => !doneKeys.has(r.set + r.hash + r.repo));
console.log(`sample ${sample.length} (${sample.filter((s) => s.set === 'review').length} review items), ${todo.length} to run`);

let i = 0, usage = { input_tokens: 0, output_tokens: 0 }, calls = 0;
async function worker() {
  while (i < todo.length) {
    const r = todo[i++];
    const q = { type: r.type, instructions: clean(r.instructions), ...(r.criteria != null ? { criteria: clean(r.criteria) } : {}) };
    const structural = new Set(lintQuestion('q', q).map((f) => f.rule));
    try {
      const res = await semanticLint({ state: null, model: 'jev-1.13.0', questions: { q } },
        { model: 'jev-1.13.0', structuralByQuestion: new Map([['q', structural]]) });
      calls += res.calls; usage.input_tokens += res.usage.input_tokens; usage.output_tokens += res.usage.output_tokens;
      done.push({ set: r.set, reviewId: r.reviewId, repo: r.repo, file: r.file, hash: r.hash, type: r.type,
        raw: res.raw.map(({ rule, pDefect }) => ({ rule, pDefect })), models: [...res.models] });
    } catch (e) { done.push({ set: r.set, reviewId: r.reviewId, repo: r.repo, file: r.file, hash: r.hash, type: r.type, error: e.message.slice(0, 160) }); }
    if (done.length % 20 === 0) writeFileSync(OUT, JSON.stringify(done));
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
writeFileSync(OUT, JSON.stringify(done));
console.log(JSON.stringify({ calls, usage, errors: done.filter((d) => d.error).length, models: [...new Set(done.flatMap((d) => d.models ?? []))] }));
