# wellposed

**Lint your jev requests before they come back confidently wrong.**

[![npm](https://img.shields.io/npm/v/wellposed)](https://www.npmjs.com/package/wellposed) [![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Offline linter and agent skill for jev requests: 45 structural checks with no model call (missing
none-of-the-above options, broken state paths, wrong criteria shapes), plus jev-on-jev checks for what
structure cannot decide, with labelled corpora that score both layers.

```
  question "route_team"
    warn   Choice "route_team" has no "other"/"none of the above" option. If an input fits none of
           [billing, technical, account], jev must still pick one — measured at confidence 1.00 on a
           wrong answer, so confidence gating will not catch it.
           fix: Add e.g. {"other": "A case that fits none of the above"}

  question "agent_name"
    error  Question "agent_name" references `ticket.assigned_agent.name`, but state has nothing at
           "ticket.assigned_agent".
```

---

## What jev is

TypeSafe's jev is a model that doesn't write text. You hand it some data and a question, and it hands
back a typed answer your code can use directly — a true/false probability, a pick from a list, or a
rating. Three question types:

- **Noul** — a yes/no question. Returns "how likely is this yes," a number from 0 to 1.
- **Choice** — pick one option from a list you provide.
- **Score** — rate something on levels you define, like `can wait` → `needs attention today`.

You send it `state` (the stuff to look at) and `questions` (what to judge). It sends back answers.
No prompt engineering, no parsing JSON out of prose.

## The problem

jev is strict about **how** you write a request and completely relaxed about **what** you ask.

Send it malformed JSON and it rejects you immediately with a precise error — wrong field type, missing
key, it tells you exactly where. That part is handled.

But ask it a *badly designed* question and it just... answers. Confidently. No warning.

We measured this. We generated 40 jev requests the way a normal developer would, then checked them:

- **0 out of 40** had syntax errors — the API's own validation already covers that completely
- **16 out of 40 (40%)** asked something that didn't make sense
- **0 out of 11** list-questions included a "none of the above" option

## Why that last one is the dangerous one

Say you write a Choice question: *"What is this email asking for?"* with four options — meeting
request, pricing question, support issue, introduction.

Then an email arrives saying **"Please remove me from this mailing list. I never signed up."**

That's none of the four. But you didn't give jev a way to say "none of these," so it has to pick one.
Here is what actually happened when we ran it:

```
without a "none of the above" option  ->  "support issue"   confidence 1.00
with    a "none of the above" option  ->  "other"           confidence 0.93
```

**Confidence 1.00.** Maximum. The model is as certain as it can possibly be, and it is wrong.

This matters because the standard advice for handling AI uncertainty is *"check the confidence score,
and send the low-confidence ones to a human."* That advice **cannot catch this bug.** The confidence is
perfect. Your monitoring sees a healthy, decisive answer. The wrong label flows into your database.

That is the whole reason wellposed exists: **some bad questions produce answers that look perfect.**
You can't catch those by inspecting the answer. You have to catch them by inspecting the question,
before you send it.

It's a paper form with no "Other" box. If a survey asks which of four departments your complaint is
about and yours is about none of them, you still tick a box. The form gets filed, looks complete, and
is wrong. Nothing downstream can tell.

The contrast that shapes the whole design: when we gave a Choice two *overlapping* options (`angry` and
`furious`), confidence **collapsed to 0.19**. That failure is loud — ordinary confidence checks catch
it fine. So wellposed doesn't spend effort there. It focuses on the failures that stay silent.

## What wellposed does about it

Four parts, cheapest first.

### 1. It teaches your coding agent to write good requests

A [`SKILL.md`](skills/wellposed/SKILL.md) that loads into Claude Code or Codex. When you say "add jev
to classify these tickets," the agent already knows:

- **Structure your data with names.** Not one blob of text — `{"ticket": {...}, "order": {...},
  "policy": "..."}`. Then point at the pieces from your question using backticks:
  ``Does `ticket.messages[0].text` request a refund?`` (This is TypeSafe's own convention; their
  playground uses it.)
- **Pick the right question type.** "How urgent is this?" is a *rating*, so it needs a Score. Ask it as
  a Noul and you get back `0.73`, which means "73% likely the answer is yes" to a question that has no
  yes.
- **One question, one judgment.** *"Is this urgent AND about billing?"* returns a single number that
  can't tell you which half was true. Split it — it costs nothing, because jev answers all your
  questions in one round trip.
- **Don't ask jev to do math.** It can't count reliably, can't compare dates, can't add. Extract the
  values with it, then do the arithmetic in your own code.
- **Batch everything.** jev reads your data once and answers all questions at the same time.
  TypeSafe's published measurement batches 13 questions into one call for ~12x cheaper and ~10x
  faster than 13 separate calls; the saving scales with question count, so expect less from a
  handful.

### 2. A linter that reads your request and finds problems — free, instantly, offline

No API key, no network, no waiting. It reads the JSON and checks 45 rules.

**Things that are definitely broken** (these fail the check):

- no instructions on a question
- wrong data type where text was expected
- a Noul's criteria given as a list instead of an object
- a Choice with duplicate options, or more than the 255 allowed
- a Score with fewer than 2 levels
- **your data is too big** — over 64,000 tokens total, or 32,000 for the data plus your longest question
- **a broken reference** — your question mentions `` `ticket.assigned_agent.name` `` but there is
  nothing at that path in your data. This one is *provably* wrong: no opinion required, just walking
  the JSON.
- **a field you said must never leave your system** — list names like `card_number` or `ssn` under
  `forbidden` in your config, and any request whose data contains one fails. Your data goes to a
  third-party API; a linter that runs before the call is the right place to catch that. Silent until
  you configure it, so it has no false positives by construction.

**Things that are probably wrong** (warnings):

- a Choice with no "none of the above" option ← the big one
- a rating question asked as a yes/no question
- asking jev to count, do arithmetic, or compare dates
- two judgments crammed into one question
- double negatives, which measurably confuse it
- **a rating whose levels are just numbers** — `["1","2","3","4","5"]`. The model evaluates each level
  on its own and never sees its number, so it has nothing to match and spreads its answer across all
  of them
- **a rating that secretly measures two things** — every level reads "the description is X and the
  tests are Y". A middle answer can't tell you which one moved
- **a question that only makes sense if you read its name** — `refund_requested: "refund?"`. The name
  is never sent to the model; it sees only "refund?"

**Suggestions** (just advice):

- Score levels that are single vague words like "weak / okay / strong" instead of real situations
- a yes/no whose "yes" description starts with "No…" — check you haven't flipped the meaning, or your
  code will read every answer backwards
- only one question in the request — you're leaving the batching discount on the table
- **data you're sending that no question ever mentions** — dead weight, and extra irrelevant data
  measurably makes jev *less* accurate

### 3. jev checking jev — for the things code can't decide

Some questions genuinely require judgment. Code can see that your Choice has no "none of the above"
option, but it can't know whether "none of these" is even *possible* for your data. That's a question
about meaning.

So for exactly those cases, wellposed asks jev about your question. Nine checks, each a simple yes/no,
and each one judgment — the rule it enforces on you, it follows itself:

- Is this really just one judgment, or several stuffed together?
- Can this be answered from the data provided, or does it need outside knowledge?
- Could two of these options both be true at once?
- Is there a realistic input none of these options would cover?
- Is this a rating question disguised as a yes/no?
- Are these rating levels actually in order?
- Do the descriptions define a different property from the one the question asks about?
- Does the "yes" description actually describe the "no" case?
- Do the rating levels run in the opposite direction to the one the question states?

The last three used to be one check that asked "do the criteria describe something different, **or**
invert the meaning" — two judgments in one question, the exact thing wellposed exists to flag. It was the
weakest check. Split into three, the reversed-scale case went from 0.08 to 0.96.

This costs one API call per question and only runs when you ask for it (`--semantic`). TypeSafe's own
guidance is to put everything in one request, and that was measured before being declined: batching ten
reviews per call saved only 14% of tokens here, because the ~12x saving comes from re-sending a *large*
shared state and a review's state is small. Meanwhile other questions in the same call moved individual
answers by up to 0.51.

**The two layers are deliberately different.** The free one is *aggressive* — it flags every Choice
missing an escape hatch, including ones that are fine, because it can't know. The paid one is
*careful* — it only gets asked the questions that genuinely need thought. Cheap-and-noisy filters
first; expensive-and-accurate resolves the leftovers.

### 4. A test set that proves the linter works

This is the part most tools skip. wellposed ships 79 hand-labelled questions, plus the
grading rubric written **before** anything was generated, so the goalposts couldn't move afterward.

Run `wellposed eval` and it scores itself:

```
  hand label                      n   caught
  ----------------------------------------------
  no-escape-hatch                 9      9/9   fully covered
  degree-as-noul                  6      6/6   fully covered
  crossed-dimensions              1      1/1   fully covered
  jev-date-comparison             2      2/2   fully covered
  jev-counting / arithmetic       2      2/2   fully covered
  jev-double-negative             1      1/1   fully covered
  bundled-judgments               3      2/3   partial
  overlapping-choice-options      1      0/1   deferred to the semantic layer
  unanswerable-from-state         2      0/2   deferred to the semantic layer

  recall    23/27 = 85% [68-94%]      precision  23/25 = 92% [75-98%]
```

In plain terms: **it catches 85% of the known problems, and 92% of what it flags is genuinely a
problem.** The bracketed ranges are 95% confidence intervals, and they are wide because the corpus is
small — read the point estimates accordingly. Those figures are exactly what `wellposed eval` prints; the table above them is an
abridged view, since the real output also counts the clean questions and names its own false
positives. Run the command for the full version. If a future change makes the linter worse, the
numbers drop and you see it.

Plus 48 unit tests. Three exist specifically because we sent those exact broken requests to the real
API and recorded what it said.

**The semantic layer has its own corpus**, added later than it should have been. 70 items, seven
defect families, five positives and five deliberately adversarial negatives each — questions that look like the
defect but are actually fine. `npm run eval:semantic` scores it with one live jev call per item:

```
  check                            n   recall  precision  unsure
  --------------------------------------------------------------
  bundled-judgments               10      4/5        4/4       1
  criteria-contradict-instructions  10      5/5        5/5       0
  degree-as-noul                  10      5/5        5/5       0
  escape-hatch-needed             10      5/5        5/5       1
  levels-unordered                10      5/5        5/5       0
  options-not-exclusive           10      5/5        5/5       0
  unanswerable-from-state         10      5/5        5/5       0

  recall    34/35 = 97% [85-99%]      precision  34/34 = 100% [90-100%]
```

The first run of this corpus scored 69%, and it found one check — `degree-as-noul` — at **0/5**. It had
been written to detect questions that literally ask "how much", and missed the whole real failure
class: yes/no questions over a gradable property with no stated cutoff ("is this pull request
risky?"). Rewording it took that check to 5/5, and the warn threshold moved from 0.65 to 0.50 for four
more true positives.

That threshold move was first justified by a sweep that could not have come out any other way. The
harness only recorded a probability when a check produced a finding, and findings only exist above the
uncertain band — so all 35 negatives were `null`, and "no false alarms at any threshold" was true by
construction. Re-measured with every answer recorded: no false alarms at any threshold from 0.35 up,
the first one at 0.30, and the closest negative sitting at 0.34 — 0.16 below the warn line. The
threshold stands; the reason it stands is now something you can check with `--dump` then `--sweep`.

**Don't quote those numbers for the three new checks** — quote the held-out ones below. The new checks
were designed after reading this corpus's five failures, and one was reworded after seeing a single test
item move, so their 5/5 here can't be told apart from fitting five items.

**Held-out validation.** A second set of 40 items was generated blind — by agents told the defect in
plain English and forbidden from reading this repository — and scored exactly once. The decision rules
were committed before the set was generated
([`HOLDOUT-RULES.md`](skills/wellposed/eval/HOLDOUT-RULES.md)), and the set itself before it was scored:

```
  check                            n   recall  precision
  -----------------------------------------------------
  criteria-polarity-inverted      10      5/5        5/5
  criteria-off-topic              10      4/5        4/4
  levels-reversed                 10      4/5        4/5
  bundled-judgments               10      3/5        3/3

  recall    16/20 = 80% [58-92%]      precision  16/17 = 94% [73-99%]
```

All four clear the pre-registered bar, two of them exactly on it. The same checks scored 9/10 on the corpus
they were designed against; 16/20 is the honest figure. `bundled-judgments` misses whenever the bundling
lives in the options or criteria rather than the instructions — a 2x2 grid of shipping options, a "yes"
description that ORs two unrelated conditions. That's a known, measured gap: a rewrite that also read the
options caught those cases but lost more plain ones than it gained, so it was reverted.

All intervals are Wilson 95%, and wide because the sets are small.

## Install

### Claude Code

```sh
claude plugin marketplace add suraj-phanindra/wellposed
claude plugin install wellposed@wellposed
```

Then `/wellposed:wellposed`, or just describe what you're building — the skill self-triggers on jev work.

### Codex, or any agent

```sh
npx skills add suraj-phanindra/wellposed --skill wellposed -a claude-code -a codex
```

Copies the skill to `~/.agents/skills/wellposed` and links each agent's directory at it. In Codex,
invoke with `$wellposed`.

### By hand

Everything lives in one directory. Copy [`skills/wellposed/`](skills/wellposed/) anywhere your agent
reads skills from, or paste
[SKILL.md](https://raw.githubusercontent.com/suraj-phanindra/wellposed/main/skills/wellposed/SKILL.md)
into the conversation.

### Just the CLI, no agent

```sh
npx wellposed lint request.json    # nothing to install
npm i -g wellposed                 # or put it on PATH
```

Node ≥ 18, zero dependencies. No API key needed for the structural checks.

## Use

```sh
npx wellposed lint request.json               # structural: free, offline, no API key
npx wellposed lint requests/*.json            # every file; fails if any of them has an error
npx wellposed lint request.json --semantic    # + jev-on-jev checks (needs TYPESAFE_API_KEY)
npx wellposed lint - < request.json           # reads stdin
npx wellposed rules                           # every rule and where it comes from
npx wellposed eval                            # score the linter against the labelled corpus
```

Already installed as a skill and want to run it offline? The CLI ships inside the skill directory -
`find ~/.claude/plugins ~/.agents/skills ~/.codex/skills -name wellposed.mjs -path '*wellposed/scripts/*' | head -1`
and call `node <that path>` instead.

Exit code is `1` when any file has errors, so it drops into CI unchanged. `--json` for machine output
(with several files it adds a `files` array alongside the aggregate `ok` and `counts`),
`--max-warnings <n>` to fail on warnings too, counted across all files.

Disagree with a rule? Turn it off. If your option list really is exhaustive, that warning is noise and
you should silence it:

```json
{ "rules": { "choice/no-escape-hatch": "off" } }
```

The same file holds a deny-list for data that must never reach the API. Each entry matches a field
name anywhere, a dotted suffix, or a full path — `card_number` catches
`customer.billing.card_number` and `records[].card_number` alike:

```json
{ "forbidden": ["password", "api_key", "ssn", "card_number"] }
```

```sh
npx wellposed lint request.json --config wellposed.config.json
```

A working example ships at
[`examples/wellposed.config.json`](skills/wellposed/examples/wellposed.config.json).

## Where everything lives

| Layer | File | Cost |
|---|---|---|
| **1. Adapter** | [`SKILL.md`](skills/wellposed/SKILL.md) | — |
| **2. Structural** | [`structural.mjs`](skills/wellposed/scripts/structural.mjs) | free, offline |
| **3. Semantic** | [`semantic.mjs`](skills/wellposed/scripts/semantic.mjs) | 1 call/question |
| **4. Eval** | [`corpus.json`](skills/wellposed/eval/corpus.json) + [`agreement.mjs`](skills/wellposed/eval/agreement.mjs) | free, offline |

## Honest limits

- **The corpus was generated and labelled by one model.** Self-grading biases the defect rate
  *downward*, so 40% is a floor, not a point estimate. The live behavioural probes exist precisely
  because they don't depend on that judgment.
- **The first version of these rules was much worse than its own metric said.** An adversarial audit
  on 2026-09-18 found six rules firing on ordinary business English — "did not receive the **invoice**"
  tripped the double-negative rule on the letters in "invoice", and a backticked option name was
  reported as a broken state path at `error` severity, failing requests the API answers at confidence
  1.00. None of those phrasings were in the 40-item corpus, so the reported precision was **unchanged
  before and after the fix**: the metric could not see them. The corpus now carries 36 adversarial
  items (`source: adversarial-2026-09-18` in `corpus.json`) specifically so it can.
- **The semantic layer ranks; it does not cleanly separate.** Clear defects scored 0.94–0.96, contested
  ones 0.60–0.74. Trust the high end, review the middle. Thresholds are tunable for a reason.
- **Semantic precision is measured within each check's own family.** Every corpus item is labelled for
  one defect only. When a check fires on an item written for a *different* defect — 26 times on the
  tuning corpus, 20 on the held-out set — that cell has no label, so it is neither counted as right nor
  wrong. Many look like real co-occurring defects (a Choice written to test overlapping options that
  also has no "other"), but they are unverified. The harness lists them rather than hiding them.
- **`choice/no-escape-hatch` over-flags by design.** Whether "none of these" is reachable is a question
  about meaning. If your option set really is exhaustive, turn the rule off.
- **One label was corrected after the fact**, and the correction is recorded in
  [`corpus.json`](skills/wellposed/eval/corpus.json) under `corrections` rather than quietly applied.
- **The semantic corpus was generated and labelled by the same model, and the two agreed 70/70.**
  Read that as self-consistency, not correctness — a bias they hold in common is invisible to it. The
  generators were at least kept blind to the check wording so the cases could not echo the grader.
  jev is a different model, so where it disagrees with these labels either side could be wrong; those
  disagreements are printed by the harness rather than hidden.
- **Rules cite their source.** `verified` means reproduced against the live API; everything else cites
  a docs page. `wellposed rules` shows which is which.
- Codex behaviour was verified against Codex as of **2026-09-17**. Older builds may need
  `codex --enable skills`.

## Credit

Four rules — the `forbidden` deny-list, `question/id-only-semantics`, `score/numeric-only-levels` and
`noul/criteria-inverted` — were prompted by reading [simota/tenbin](https://github.com/simota/tenbin),
which covers overlapping ground as an MCP server. The implementations here are independent, and the
comparison also turned up two bugs in wellposed itself, which are fixed.

## Not affiliated with TypeSafe

This is an independent tool. TypeSafe, System One and jev are theirs; the rules here are drawn from
their public documentation, which is the authority whenever it and this tool disagree — in particular
[jev-1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), the most useful page in the
docs and the one most often skipped.

## Development

```sh
npm test                 # 48 unit tests, zero dependencies
npm run eval             # score the linter against the corpus
npm run lint:example     # lint the bundled example
```

MIT.
