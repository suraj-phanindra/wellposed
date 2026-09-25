// Held-out set for the semantic/degree-as-noul rewording, drawn and committed before
// any label or score exists. Degree questions are ~6% of wild Nouls (4 of 71 labelled),
// so a plain sample would hold too few positives to measure recall. Two strata:
//   G: instructions name a property that comes in degrees (lexical screen below)
//   R: every other fully literal Noul
// 40 from G and up to 40 from R (repos already in G are skipped; 35 remained), one per
// repo, excluding every question any earlier packet showed a
// reviewer. Results are reported per stratum, never pooled as if random.
// Scoring plan: the old wording (git HEAD) and the new wording, both through
// semanticLint as production runs it, pinned to jev-1.13.0; a check "fires" at pDefect
// > 0.50; labels are the consensus of two blind reviewers (opus + sonnet), splits and
// "unclear" reported separately. The new wording ships only if, on this set, it keeps
// recall within one item of the old wording and flags fewer consensus-clean Nouls.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const P = JSON.parse(readFileSync('primary.json', 'utf8'));
const seen = new Set();
for (const d of ['review', 'review2', 'review3']) for (const k of JSON.parse(readFileSync(`${d}/key.json`, 'utf8'))) { seen.add(k.repo + '|' + k.file); if (k.hash) seen.add(k.repo + '#' + k.hash); }
for (const s of JSON.parse(readFileSync('semantic-results.json', 'utf8'))) seen.add(s.repo + '#' + s.hash);
const GRADABLE = /\b(urgen\w*|sever\w*|risk\w*|serious\w*|strong\w*|weak\w*|good|bad|poor|quality|significant\w*|important|relevan\w*|reliab\w*|toxic\w*|harmful|offensive|high|low|large|small|clear\w*|fit|appropriate|confiden\w*|complex\w*|difficult\w*|valuable|useful|helpful|accurate|safe|dangerous|critical|major|minor|positive|negative|aggressive|polite|rude|professional|engag\w*|persuasive|credible|trustworth\w*|ready|mature|stable)\b|紧急|严重|风险|危险|重要/i;
const h = (s) => createHash('sha1').update('degree-holdout-1' + s).digest('hex');
const text = (v) => typeof v === 'string' ? v : v && v.__template__ ? v.__template__ : JSON.stringify(v);
const pool = P.filter((r) => r.type === 'noul' && r.instrLit && (r.criteria == null || r.critLit)
  && !seen.has(r.repo + '|' + r.file) && !seen.has(r.repo + '#' + r.hash))
  .sort((a, b) => h(a.hash + a.repo).localeCompare(h(b.hash + b.repo)));
const pick = (stratum, n) => { const repos = new Set(); return pool.filter((r) => (GRADABLE.test(text(r.instructions)) ? 'G' : 'R') === stratum)
  .filter((r) => !repos.has(r.repo) && repos.add(r.repo)).slice(0, n).map((r) => ({ ...r, stratum })); };
const G = pick('G', 40), R = pick('R', 40).filter((r) => !G.some((g) => g.repo === r.repo));
const all = [...G, ...R].sort((a, b) => h(a.hash).localeCompare(h(b.hash)));   // strata interleaved
const def = 'DEGREE ASKED AS YES/NO: a yes/no question about how much of a gradable property something has, with no stated threshold (e.g. "Is this very urgent?", "Is the essay good?"), where the answer is really a position on a scale. A yes/no question about a sharply defined condition, or one whose cutoff is stated, is ABSENT.';
const items = all.map((r, i) => ({ id: `G${String(i + 1).padStart(2, '0')}`, check: 'G', type: 'noul', question_id: r.qid,
  instructions: r.instructions && r.instructions.__template__ ? r.instructions.__template__ : r.instructions, ...(r.criteria != null ? { criteria: r.criteria } : {}) }));
writeFileSync('degree/packet.json', JSON.stringify({ definitions: { G: def }, items }, null, 1));
writeFileSync('degree/key.json', JSON.stringify(all.map((r, i) => ({ id: items[i].id, stratum: r.stratum, repo: r.repo, file: r.file, hash: r.hash }))));
console.log(`pool ${pool.length} Nouls; picked G ${G.length}, R ${R.length}`);
