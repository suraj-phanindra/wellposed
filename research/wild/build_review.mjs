// Blind review packet: flagged questions mixed with unflagged controls, shuffled, no
// repo or file names, and no hint of which were flagged. Key kept separately.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const P = JSON.parse(readFileSync('primary.json', 'utf8'));
const h = (s) => createHash('sha1').update('wild-review-1' + s).digest('hex');   // seeded shuffle
const shuffle = (a) => [...a].sort((x, y) => h(JSON.stringify(x)).localeCompare(h(JSON.stringify(y))));
const onePerRepo = (a) => { const s = new Set(); return a.filter((r) => !s.has(r.repo) && s.add(r.repo)); };
const words = (r) => (typeof r.instructions === 'string' ? r.instructions : JSON.stringify(r.instructions ?? '')).trim().split(/\s+/).length;

const DEF = {
  E: ['choice/no-escape-hatch', (r) => r.type === 'choice',
      'NEEDS AN ESCAPE HATCH: some realistic input would make NONE of the listed options a correct answer, and no option covers that case (e.g. "other", "none of these", "unknown", "not stated"). If the options are exhaustive for any input the question could plausibly be asked about, or one option already covers "none/other/unknown", the defect is ABSENT.', 30, 12],
  B: ['jev/bundled-judgments', (r) => true,
      'BUNDLED JUDGMENTS: the question asks for two or more separate judgments at once (e.g. "Is it urgent and about billing?"), so one answer cannot say which part drove it. A single condition that merely has several examples, or one property defined by a list, is ABSENT.', 40, 20],
  C: ['jev/counting', (r) => true,
      'REQUIRES COUNTING: answering correctly requires counting items in the input (how many X, more than N of Y). Mentioning a number that is not a count of things in the input is ABSENT.', 30, 15],
  D: ['jev/double-negative', (r) => true,
      'DOUBLE NEGATIVE: the question is phrased with two negations or an indirection that makes yes/no confusing (e.g. "Is it not untrue that...", "Does it fail to not..."). One ordinary negation ("Is it not spam?") is ABSENT.', 20, 10],
  I: ['question/id-only-semantics', (r) => true,
      'MEANING MISSING FROM THE TEXT: the model sees ONLY the instructions and criteria, never the question id. The defect is PRESENT when instructions + criteria alone do not say what is being judged (e.g. id "refund_requested", instructions "refund?"). If the text alone is clear, it is ABSENT.', 30, 15],
  G: ['noul/degree-question', (r) => r.type === 'noul',
      'DEGREE ASKED AS YES/NO: a yes/no question about how much of a gradable property something has, with no stated threshold (e.g. "Is this very urgent?", "How serious is it?"), where the answer is really a position on a scale. A yes/no question with a clear cutoff is ABSENT.', 10, 10],
  T: ['jev/date-comparison', (r) => true,
      'REQUIRES DATE COMPARISON: answering correctly requires comparing or ordering dates or durations from the input (before/after a date, within N days). Merely mentioning time is ABSENT.', 10, 6],
  A: ['jev/arithmetic', (r) => true,
      'REQUIRES ARITHMETIC: answering correctly requires computing sums, differences, percentages or totals from numbers in the input. Mentioning a single number is ABSENT.', 10, 6],
  L: ['score/bare-levels', (r) => r.type === 'score',
      'BARE LEVELS: the Score levels are bare labels ("low", "medium", "high", "1".."5") rather than descriptions of concrete situations a reader could recognise. Levels that describe what each rung looks like are ABSENT.', 20, 10],
};
const packet = [], key = [];
for (const [code, [rule, typeOk, def, nFlag, nCtl]] of Object.entries(DEF)) {
  const applicable = P.filter((r) => typeOk(r) && r.findings !== undefined);
  let flagged = onePerRepo(shuffle(applicable.filter((r) => r.findings.includes(rule))));
  if (flagged.length < nFlag) flagged = shuffle(applicable.filter((r) => r.findings.includes(rule))).slice(0, nFlag);
  flagged = flagged.slice(0, nFlag);
  // Controls: same type, not flagged; for id-only prefer short instructions so it is not trivial.
  let pool = applicable.filter((r) => !r.findings.includes(rule));
  if (code === 'I') pool = pool.filter((r) => words(r) <= 6);
  if (code === 'E') pool = pool.filter((r) => r.type === 'choice');
  const controls = onePerRepo(shuffle(pool)).slice(0, nCtl);
  const items = shuffle([...flagged.map((r) => [r, true]), ...controls.map((r) => [r, false])]);
  items.forEach(([r, f], i) => {
    const id = `${code}${String(i + 1).padStart(2, '0')}`;
    packet.push({ id, check: code, type: r.type, question_id: r.qid, instructions: r.instructions ?? null, ...(r.criteria != null ? { criteria: r.criteria } : {}) });
    key.push({ id, rule, flagged: f, repo: r.repo, file: r.file });
  });
}
const defs = Object.fromEntries(Object.entries(DEF).map(([c, [, , d]]) => [c, d]));
writeFileSync('review/packet.json', JSON.stringify({ definitions: defs, items: packet }, null, 1));
writeFileSync('review/key.json', JSON.stringify(key));
const c = {}; for (const k of key) { c[k.rule] ??= [0, 0]; c[k.rule][k.flagged ? 0 : 1]++; }
console.log(packet.length, 'items'); for (const [r, [f, n]] of Object.entries(c)) console.log(' ', r.padEnd(28), 'flagged', f, 'controls', n);
