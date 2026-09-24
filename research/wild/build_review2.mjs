// Blind packet for the semantic layer's calls on the per-repo sample. Reviewers never
// see jev's probabilities; the key keeps them for scoring.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const P = JSON.parse(readFileSync('primary.json', 'utf8'));
const S = JSON.parse(readFileSync('semantic-results.json', 'utf8')).filter((x) => x.set === 'sample' && !x.error);
const h = (s) => createHash('sha1').update('wild-review-2' + s).digest('hex');
const shuffle = (a) => [...a].sort((x, y) => h(JSON.stringify(x)).localeCompare(h(JSON.stringify(y))));
const find = (s) => P.find((r) => r.repo === s.repo && r.hash === s.hash);
const DEF = {
  X: ['semantic/options-not-exclusive', 'OPTIONS OVERLAP: a realistic input could make two or more of the options correct at the same time, so the model must choose between true answers. If the options are mutually exclusive by their names/descriptions (an input can fit only one), the defect is ABSENT.'],
  H: ['semantic/escape-hatch-needed', 'NEEDS AN ESCAPE HATCH: some realistic input would make NONE of the listed options a correct answer, and no option covers that case (e.g. "other", "none of these", "unknown", "not stated"). If the options are exhaustive for any input the question could plausibly be asked about, or one option already covers "none/other/unknown", the defect is ABSENT.'],
  G: ['semantic/degree-as-noul', 'DEGREE ASKED AS YES/NO: a yes/no question about how much of a gradable property something has, with no stated threshold (e.g. "Is this very urgent?", "Is the essay good?"), where the answer is really a position on a scale. A yes/no question about a sharply defined condition, or one whose cutoff is stated, is ABSENT.'],
  U: ['semantic/levels-unordered', 'LEVELS OUT OF ORDER: the Score levels, in the order listed, do not run in one consistent direction (least to most, or most to least) of a single property. Levels that are consistently ordered are ABSENT.'],
  B: ['semantic/bundled-judgments', 'BUNDLED JUDGMENTS: the question asks for two or more separate judgments at once (e.g. "Is it urgent and about billing?"), so one answer cannot say which part drove it. A single condition that merely has several examples, or one property defined by a list, is ABSENT.'],
};
const packet = [], key = [];
for (const [code, [rule, def]] of Object.entries(DEF)) {
  let asked = S.filter((s) => s.raw.some((c) => c.rule === rule));
  if (code === 'B') {           // 150 askings, 5 fired: keep all fired/uncertain + 13 others
    const p = (s) => s.raw.find((c) => c.rule === rule).pDefect;
    asked = [...asked.filter((s) => p(s) >= 0.35), ...shuffle(asked.filter((s) => p(s) < 0.35)).slice(0, 13)];
  }
  shuffle(asked).forEach((s, i) => {
    const r = find(s); const id = `${code}${String(i + 1).padStart(2, '0')}`;
    const clean = (v) => v && typeof v === 'object' && !Array.isArray(v) && '__template__' in v ? v.__template__ : v;
    packet.push({ id, check: code, type: r.type, question_id: r.qid, instructions: clean(r.instructions) ?? null, ...(r.criteria != null ? { criteria: r.criteria } : {}) });
    key.push({ id, rule, pDefect: s.raw.find((c) => c.rule === rule).pDefect, repo: s.repo, hash: s.hash });
  });
}
writeFileSync('review2/packet.json', JSON.stringify({ definitions: Object.fromEntries(Object.entries(DEF).map(([c, [, d]]) => [c, d])), items: packet }, null, 1));
writeFileSync('review2/key.json', JSON.stringify(key));
const c = {}; for (const k of key) c[k.rule] = (c[k.rule] ?? 0) + 1; console.log(packet.length, c);
