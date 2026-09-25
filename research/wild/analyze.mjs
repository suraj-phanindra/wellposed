// Classify, dedupe, cap, and lint the extracted wild questions with wellposed's own
// structural layer. Each rule's prevalence uses only questions where the fields that
// rule reads are literal — a runtime-built option list is unknown, not defective.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lintQuestion, RULES } from '../../skills/wellposed/scripts/structural.mjs';

const CAP = Number(process.argv[2] ?? 25);
const raw = [...JSON.parse(readFileSync('questions_py.json', 'utf8')), ...JSON.parse(readFileSync('questions_js.json', 'utf8'))];
const callsTypesafe = JSON.parse(readFileSync('calls_typesafe.json', 'utf8'));
const repoMeta = Object.fromEntries(JSON.parse(readFileSync('repos.json', 'utf8')).map((r) => [r.repo.toLowerCase(), r]));

const isDyn = (v) => v && typeof v === 'object' && !Array.isArray(v) && ('__dynamic__' in v);
// Deep: structured instructions like {"goal": <runtime>, "rules": <runtime>} otherwise
// passed as literal, and the linter saw only their key names.
const hasDynInside = (v) => v != null && typeof v === 'object' && (isDyn(v) || '__spread__' in v || '__dynkey__' in v
  || Object.values(v).some((x) => hasDynInside(x)));
const clean = (v) => isDyn(v) ? null : v && typeof v === 'object' && !Array.isArray(v) && '__template__' in v ? v.__template__
  : Array.isArray(v) ? v.map(clean) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v;

const GENERATED_DIR = /(^|\/)(results?|outputs?|logs?|runs?|data|datasets?|benchmarks?|fixtures?|snapshots?|cache|artifacts?)(\/|$)/i;
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec|test-d)\.[a-z]+$|(^|\/)(e2e|smoke)[^/]*$|(^|\/)test_[^/]+\.py$|_test\.py$/i;
const perFile = {};
for (const q of raw) perFile[q.repo + '|' + q.file] = (perFile[q.repo + '|' + q.file] ?? 0) + 1;

const rows = raw.map((q) => {
  const instrLit = q.instructions != null && !hasDynInside(q.instructions);
  const critLit = q.criteria != null && !hasDynInside(q.criteria);
  const generated = q.lang === 'json' && (GENERATED_DIR.test(q.file) || perFile[q.repo + '|' + q.file] > 25);
  const meta = repoMeta[q.repo.toLowerCase()] ?? {};
  return { ...q, instrLit, critLit, generated,
    test: TEST_DIR.test(q.file), official: /^typesafe-ai\//i.test(q.repo), adjacent: Boolean(meta.adjacent), callsApi: Boolean(callsTypesafe[q.repo]),
    hash: createHash('sha1').update(JSON.stringify([q.type, q.instructions, q.criteria])).digest('hex') };
});

// Which fields each rule reads. A question counts toward a rule only if those are literal.
// Rules that prove something is *absent* are skipped: an extractor that missed a field
// looks exactly like a request that omitted it. State and context rules need the whole
// request, which wild code almost always builds at runtime.
const ABSENCE = /missing|empty-key|invalid-type|not-an-object/;
function applies(rule, r) {
  const ns = rule.split('/')[0];
  if (ABSENCE.test(rule)) return false;
  if (ns === 'jev' || rule === 'noul/degree-question' || rule === 'instructions/wrong-type') return r.instrLit;
  if (rule === 'question/id-only-semantics') return r.instrLit && r.qid != null;
  if (ns === 'choice' || ns === 'score') return r.type === ns && r.critLit;
  if (ns === 'noul') return r.type === 'noul' && r.critLit && (rule !== 'noul/criteria-inverted' || r.instrLit);
  return false;
}
const QUESTION_RULES = Object.keys(RULES).filter((id) => !/^(request|state|context)\//.test(id) && !ABSENCE.test(id));

function select(filter) {
  const perRepo = {}; const out = [];
  for (const r of rows.filter(filter).sort((a, b) => a.hash.localeCompare(b.hash))) {
    const s = (perRepo[r.repo] ??= new Set());
    if (s.has(r.hash) || s.size >= CAP) continue;
    s.add(r.hash); out.push(r);
  }
  return out;
}
function lintAll(set) {
  for (const r of set) {
    const q = { type: r.type, instructions: clean(r.instructions), ...(r.criteria != null ? { criteria: clean(r.criteria) } : {}) };
    r.findings = new Set(lintQuestion(r.qid ?? 'q', q).map((f) => f.rule).filter((rule) => applies(rule, r)));
  }
  return set;
}
function report(label, set) {
  const repos = new Set(set.map((r) => r.repo));
  const lines = [`\n  ${label}: ${set.length} questions from ${repos.size} repos`];
  lines.push('  ' + 'rule'.padEnd(34) + 'sev'.padEnd(6) + 'questions'.padStart(16) + 'repos'.padStart(16));
  for (const rule of QUESTION_RULES) {
    const app = set.filter((r) => applies(rule, r)); if (!app.length) continue;
    const hit = app.filter((r) => r.findings.has(rule));
    const appRepos = new Set(app.map((r) => r.repo)), hitRepos = new Set(hit.map((r) => r.repo));
    const pct = (a, b) => `${a}/${b} ${String(Math.round(100 * a / b)).padStart(3)}%`;
    if (!hit.length) continue;
    lines.push('  ' + rule.padEnd(34) + RULES[rule].severity.padEnd(6) + pct(hit.length, app.length).padStart(16) + pct(hitRepos.size, appRepos.size).padStart(16));
  }
  return lines.join('\n');
}

// Test directories hold deliberate negative cases ("too few levels" on purpose), so the
// headline is shipped code only; everything else is reported beside it, never mixed in.
const primary = lintAll(select((r) => !r.generated && !r.official && !r.test));
const out = [
  `CAP ${CAP} unique questions per repo. Extracted in total: ${raw.length} (${new Set(rows.map((r) => r.hash)).size} unique).`,
  report('PRIMARY: authored, non-test code, excluding TypeSafe\'s own repos', primary),
  report('  same, without lint/eval/bench-adjacent repos', primary.filter((r) => !r.adjacent)),
  report('  same, only repos that visibly call TypeSafe\'s API or SDK', primary.filter((r) => r.callsApi)),
  report('test directories', lintAll(select((r) => !r.generated && !r.official && r.test))),
  report('TypeSafe\'s own repos (typesafe-ai/*)', lintAll(select((r) => !r.generated && r.official))),
  report('generated/result logs', lintAll(select((r) => r.generated && !r.official))),
];
console.log(out.join('\n'));
writeFileSync('primary.json', JSON.stringify(primary.map(({ findings, ...r }) => ({ ...r, findings: [...findings] }))));
