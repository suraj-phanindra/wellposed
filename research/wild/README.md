# jev in the wild

wellposed run over jev questions pulled from public GitHub code, 2026-09-24 (rule fixes 2026-09-25), pinned to
`jev-1.13.0`. Only aggregates are published here. No repo is named, and the harvested code and
per-repo results stay local (gitignored).

## Headline

**73% of the repos that write a Choice (260 of 358) have at least one with no escape hatch. That
is 60% of Choices (663 of 1,106).** The share holds across slices: 73% excluding lint/eval/bench
repos, and 72% counting only repos that visibly call TypeSafe's API or SDK.

A missing hatch is not always a defect, because some option sets really are exhaustive. On a
fresh sample of 40 flagged Choices, drawn and committed before anyone labelled it, two blind
reviewers agreed on 35. Of those 35, **15 need a hatch: 43% [28–59%]**. So roughly **one literal
Choice in four** (about 17–35%) is missing an escape hatch it needs. wellposed's own measurements
show that failure mode answers wrong at confidence 1.00.

After the fixes below, every other warning fires in 3% of repos or fewer. Advisory
`score/bare-levels` fires in 23%. Of the error-level
findings in shipped code, **none** held up: all came from jev-compatible reimplementations, smoke
tests or recipe files that accept looser shapes than TypeSafe's API.

## What running on real code found in wellposed

These are all fixed and committed, with no version bump.

| Commit | Defect | Evidence |
|---|---|---|
| 5811be3 | **Crash**: every release since 0.1.0 threw on a Choice whose option descriptions are objects (`{"what": …, "examples": […]}`) | 40 Choices in 17 repos use that shape |
| 5a00a3e | Escape hatches named `missing`, `nothing`, `insufficient_*`, `skip`, `abstain`, `no_*`, `none_*` were not recognised, and `none_of_these` failed a regex typo | reviewer reasons; headline moved from 79% to 73% of repos |
| 0bcb01c | `noul/degree-question` flagged "How likely is X?" | jev: 12 paired phrasings kept their order, max \|ΔP\| 0.11. All 6 wild flags were this phrasing |
| d9d1a5c | Noul criteria under `yes`/`no` keys were a warning | live: 200 OK, P(yes) 0.50 against 0.48 with no criteria and 0.98 under `true`/`false`. Silently dropped, so now an error. 4 Nouls in 3 repos |
| 05d4284 | The one-level Score message said the API rejects it | live: 200, level 0 at confidence 1.00. The JS SDK is what rejects it |
| 5a098b0 | `jev/double-negative` paired negations across clauses and read "Do not infer … without evidence" guidance as the condition | 12 wild hits became 2. All 10 dropped were consensus-clean |
| 9298152 | `jev/bundled-judgments` fired on "and" in clarifying statements and in wh-questions | 33 hits became 4 (3 consensus-real). 24 consensus-clean hits dropped, 1 real one lost |
| 5127273 | `jev/counting` fired on "how many" in descriptions, in decisions ("how many … should") and in dismissals ("no matter how many") | 25 hits became 20. All 5 dropped were consensus-clean, and no real one was lost |
| 7328a4c | Semantic `degree-as-noul` flagged decisions, entity matches and category checks | Pre-registered held-out of 75 fresh wild Nouls: recall 9/10 → 8/10, clean Nouls flagged 11/47 → 3/47, precision 9/20 → 8/11. Semantic corpus unchanged at 34/35 and 34/34 |
| 1fe032d | A network timeout ended a semantic run instead of being retried | seen during these runs |
| e9608b1 | Chinese and Japanese text counted as one word, so full questions were called meaningless | id-only-semantics went from 65 hits in 42 repos to 16 in 14. Every consensus-clean id-only flag had been CJK |

## False positives: blind review

Two reviewers labelled each item: Claude Opus and Claude Sonnet, both LLMs, which is a stated
limit. Neither saw wellposed's code or which items it had flagged. Flagged items were mixed with
unflagged controls. The precision column counts only items where both reviewers agreed, and it is measured
before the fixes above. The "after fix" column re-scores the same items, so it was tuned on them
and is optimistic. For the structural fixes no unreviewed wild hit remains to check them on.

| Rule | Precision on wild code | After fix, same items | κ |
|---|---|---|---|
| `choice/no-escape-hatch` | — | **fresh sample: 15/35 need one, 43% [28–59%]** | — |
| `score/bare-levels` (info) | 18/20, 90% [70–97%] | unchanged | 1.00 |
| `jev/counting` | 10/25, 40% [23–59%] | 10/20. Of the 7 clean-labelled warnings left, 4 are arithmetic or date math the skill also sends to code | 1.00 |
| `question/id-only-semantics` | 3/11, 27% [10–57%] | what remains is genuinely terse ("Urgent?", "Pick one") | 0.59 |
| `jev/bundled-judgments` | 4/29, 14% [5–31%] | 3/4 | 0.69 |
| `jev/double-negative` | 0/10, 0% [0–28%] | 0/0. The 2 kept were split or unclear | — |
| `jev/arithmetic`, `jev/date-comparison` | 0/3, 2/3 | unchanged; too few to judge | — |

Semantic layer (jev-on-jev), one question from each of 150 repos:

| Check | Fired | Precision, both reviewers agreeing |
|---|---|---|
| `options-not-exclusive` | 32/48 Choices | **20/22, 91% [72–97%]**. Overlapping options are common and real |
| `escape-hatch-needed` | 30/36 | 16/21, 76% [55–89%]. On the fresh sample: 15/26, 58% [39–74%], **recall 15/15** |
| `degree-as-noul` | 19/81 Nouls | **4/14, 29% [12–55%]**, fixed by rewording (7328a4c). On a fresh held-out set it now scores 8/11, 73% [43–90%] |
| `bundled-judgments` | 5/150 | 1/3. Too few to judge |

## Do these defects cause wrong answers?

Two experiments, each pre-registered in a committed script before any input existed: `outcome_hatch.mjs`
(81e99d9) and `outcome_overlap.mjs` (816755e). A blind generator wrote inputs for real questions. An
independent model checked each one without being told its intent, and only inputs it agreed with were
kept. jev-1.13.0 answered one question per request.

**Missing escape hatch.** 31 real Choices that both reviewers said need one.

| | Result |
|---|---|
| Inputs that fit none of the options, as written | wrong every time; **36% [25–49%] at confidence ≥ 0.9** (22/61), 41% at ≥ 0.8, mean 0.66 |
| Questions that gave at least one confidently wrong answer | 19 of 31 |
| Same inputs with `"other"` added | **90% [80–95%] answered "other"** (55/61) |
| Inputs that fit one option, with and without `"other"` | 62/62 correct both ways; the hatch took nothing |

A confidence gate at 0.9 catches about two-thirds of these failures and misses a third. The earlier
claim that gating "cannot catch" them came from a single example at confidence 1.00. That claim was
too strong, and the warning now states the measured rate.

**Overlapping options.** 14 real Choices both reviewers said overlap. 25 inputs had two options both
true, and 32 inputs had one.

| | Two true | One true |
|---|---|---|
| Answer changed when the option order was reversed | **0/25** [0–13%] | 0/32 |
| Picked the first-listed of the two true options | 24/50, chance | — |
| Confidence ≥ 0.9 | 10/25 | 31/32 |
| Mean confidence | 0.82 | 0.98 |

The pick is not arbitrary. jev returns one of the true options consistently. The cost is lower
confidence, plus a second label that the code never sees. The overlap message used to say "unstable",
and now says this instead.

## Method

1. **Discovery.** 1,247 repos from the awesome-jev lists and code search. 32 were excluded:
   linters (including wellposed) and the lists themselves. 1,201 cloned, and 1,031 had
   candidate files.
2. **Extraction.** `extract_py.py` uses Python's `ast`, plus notebooks and JSON.
   `extract_js.mjs` uses Babel for JS and TS. Only exact literals are kept. Runtime values
   become markers, and a rule counts a question only if the fields that rule reads are
   literal. SDK constructors count only when imported from a TypeSafe module, because
   third-party wrappers ship their own `Choice` with other signatures.
3. **Headline set.** 152,864 extracted questions, 13,922 unique. The headline keeps only
   authored code. That excludes result logs (JSON under results/data/benchmarks, or files
   with more than 25 questions), test directories (deliberate negative cases), and
   TypeSafe's own repos. It then dedupes within each repo and caps at 25 per repo, for
   **5,684 questions from 825 repos** (Noul 2,371, Choice 2,344, Score 969). 3,468 of them
   are fully literal. All 825 repos mention jev or TypeSafe, and 96% of the questions sit in
   a file that does.
4. **Review.** Packets 1 and 2 (`build_review*.mjs`) informed the fixes above. Packet 3 was
   drawn after the fixes and committed (21e2a1d) before labelling, so it is the independent
   figure.

Also seen: 167 repos pin `model: "jev-1.13.0"`. 6 use the two-part `jev-1.13`, and some of
those route through OpenRouter, where that id may be valid.

## Limits

- Runtime-built questions are invisible. 2,216 of the 5,684 are partly built at runtime.
- The reviewers are LLMs, not humans. Agreement varies by rule, as the κ column shows.
- Whether a Choice needs a hatch depends on the input distribution, which code does not
  show. The two earlier packets disagreed (19% and 59%). The fresh 43% sits between them.
- The structural fixes were tuned on the reviewed items, and those items are now spent.
  The next labelled set has to come from new repos or from a later harvest.
- What counts as a degree question is contested. On the degree held-out the two reviewers
  agreed on 57 of 72 decided pairs, and Sonnet called 25 items degree where Opus called 11.
