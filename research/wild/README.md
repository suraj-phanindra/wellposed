# jev in the wild

wellposed run over jev questions pulled from public GitHub code, 2026-09-24, pinned to
`jev-1.13.0`. Only aggregates are published here. No repo is named, and the harvested code and
per-repo results stay local (gitignored).

## Headline

**73% of the repos that write a Choice (260 of 358) have at least one with no escape hatch. That
is 60% of Choices (664 of 1,108).** The share holds across slices: 73% excluding lint/eval/bench
repos, and 72% counting only repos that visibly call TypeSafe's API or SDK.

A missing hatch is not always a defect, because some option sets really are exhaustive. On a
fresh sample of 40 flagged Choices, drawn and committed before anyone labelled it, two blind
reviewers agreed on 35. Of those 35, **15 need a hatch: 43% [28–59%]**. So roughly **one literal
Choice in four** (about 17–35%) is missing an escape hatch it needs. wellposed's own measurements
show that failure mode answers wrong at confidence 1.00.

Nearly every other structural defect is rare, at 4% of repos or fewer. The exceptions are
`question/id-only-semantics` (8%) and advisory `score/bare-levels` (28%). Of the error-level
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

## False positives: blind review

Two reviewers labelled each item: Claude Opus and Claude Sonnet, both LLMs, which is a stated
limit. Neither saw wellposed's code or which items it had flagged. Flagged items were mixed with
unflagged controls. The precision column counts only items where both reviewers agreed.

| Rule | Precision on wild code | κ | Verdict |
|---|---|---|---|
| `choice/no-escape-hatch` (after fix, fresh sample) | 15/35 need one, 43% [28–59%] | — | the flag is a fact (no hatch); need is a judgment |
| `score/bare-levels` (info) | 18/20, 90% [70–97%] | 1.00 | holds |
| `jev/counting` | 10/25, 40% [23–59%] | 1.00 | over-fires on "how many stars did they give" and on general-knowledge questions |
| `question/id-only-semantics` | 3/11, 27% [10–57%] | 0.59 | 27 of 45 items were split or unclear |
| `jev/bundled-judgments` | 4/29, 14% [5–31%] | 0.69 | fires on "and" inside long clarifying instructions |
| `jev/double-negative` | 0/10, 0% [0–28%] | — | fires on guidance such as "Do not infer … without evidence" |
| `jev/arithmetic`, `jev/date-comparison` | 0/3, 2/3 | — | too few to judge |

Semantic layer (jev-on-jev), one question from each of 150 repos:

| Check | Fired | Precision, both reviewers agreeing |
|---|---|---|
| `options-not-exclusive` | 32/48 Choices | **20/22, 91% [72–97%]**. Overlapping options are common and real |
| `escape-hatch-needed` | 30/36 | 16/21, 76% [55–89%]. On the fresh sample: 15/26, 58% [39–74%], **recall 15/15** |
| `degree-as-noul` | 19/81 Nouls | **4/14, 29% [12–55%]**. No threshold separates hits from misses, so the wording is the problem |
| `bundled-judgments` | 5/150 | 1/3. Too few to judge |

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
   **5,684 questions from 825 repos** (Noul 2,371, Choice 2,344, Score 969). 3,525 of them
   are fully literal. All 825 repos mention jev or TypeSafe, and 96% of the questions sit in
   a file that does.
4. **Review.** Packets 1 and 2 (`build_review*.mjs`) informed the fixes above. Packet 3 was
   drawn after the fixes and committed (21e2a1d) before labelling, so it is the independent
   figure.

Also seen: 167 repos pin `model: "jev-1.13.0"`. 6 use the two-part `jev-1.13`, and some of
those route through OpenRouter, where that id may be valid.

## Limits

- Runtime-built questions are invisible. 2,159 of the 5,684 are partly built at runtime.
- The reviewers are LLMs, not humans. Agreement varies by rule, as the κ column shows.
- Whether a Choice needs a hatch depends on the input distribution, which code does not
  show. The two earlier packets disagreed (19% and 59%). The fresh 43% sits between them.
- The fixes to `double-negative`, `bundled-judgments`, `counting` and semantic
  `degree-as-noul` are **not** made. Each needs a rule change plus a fresh validation
  sample.
