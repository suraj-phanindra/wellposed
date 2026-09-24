// Fresh validation of the escape-hatch headline, drawn AFTER the hatch-name fix and
// committed before any label exists. Flagged, fully literal Choices, one per repo,
// excluding every question either earlier packet showed a reviewer. Question asked:
// of Choices wellposed now flags, what share actually need an escape hatch?
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const P = JSON.parse(readFileSync('primary.json', 'utf8'));
const seen1 = new Set(JSON.parse(readFileSync('review/key.json', 'utf8')).map((k) => k.repo + '|' + k.file));
const seen2 = new Set(JSON.parse(readFileSync('review2/key.json', 'utf8')).map((k) => k.repo + '|' + k.hash));
const h = (s) => createHash('sha1').update('wild-review-3' + s).digest('hex');
const pool = P.filter((r) => r.type === 'choice' && r.instrLit && r.critLit && r.findings.includes('choice/no-escape-hatch')
  && !seen1.has(r.repo + '|' + r.file) && !seen2.has(r.repo + '|' + r.hash))
  .sort((a, b) => h(a.hash + a.repo).localeCompare(h(b.hash + b.repo)));
const repos = new Set(); const pick = pool.filter((r) => !repos.has(r.repo) && repos.add(r.repo)).slice(0, 40);
const clean = (v) => v && typeof v === 'object' && !Array.isArray(v) && '__template__' in v ? v.__template__ : v;
const def = 'NEEDS AN ESCAPE HATCH: some realistic input would make NONE of the listed options a correct answer, and no option covers that case (e.g. "other", "none of these", "unknown", "not stated"). If the options are exhaustive for any input the question could plausibly be asked about, or one option already covers "none/other/unknown", the defect is ABSENT.';
const items = pick.map((r, i) => ({ id: `H${String(i + 1).padStart(2, '0')}`, check: 'H', type: r.type, question_id: r.qid, instructions: clean(r.instructions), criteria: r.criteria }));
writeFileSync('review3/packet.json', JSON.stringify({ definitions: { H: def }, items }, null, 1));
writeFileSync('review3/key.json', JSON.stringify(pick.map((r, i) => ({ id: items[i].id, rule: 'choice/no-escape-hatch', flagged: true, repo: r.repo, file: r.file, hash: r.hash }))));
console.log(`pool ${pool.length}, picked ${pick.length} from ${repos.size} repos`);
