# wellposed

**Lint TypeSafe System One (jev) requests before you send them.**

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
- **Batch everything.** jev reads your data once and answers all questions at the same time. One
  request with ten questions is documented as ~12x cheaper and ~10x faster than ten requests.

### 2. A linter that reads your request and finds problems — free, instantly, offline

No API key, no network, no waiting. It reads the JSON and checks about 21 rules.

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

**Things that are probably wrong** (warnings):

- a Choice with no "none of the above" option ← the big one
- a rating question asked as a yes/no question
- asking jev to count, do arithmetic, or compare dates
- two judgments crammed into one question
- double negatives, which measurably confuse it

**Suggestions** (just advice):

- Score levels that are single vague words like "weak / okay / strong" instead of real situations
- only one question in the request — you're leaving the batching discount on the table
- **data you're sending that no question ever mentions** — dead weight, and extra irrelevant data
  measurably makes jev *less* accurate

### 3. jev checking jev — for the things code can't decide

Some questions genuinely require judgment. Code can see that your Choice has no "none of the above"
option, but it can't know whether "none of these" is even *possible* for your data. That's a question
about meaning.

So for exactly those cases, wellposed asks jev about your question. Seven checks, each a simple yes/no:

- Is this really just one judgment, or several stuffed together?
- Can this be answered from the data provided, or does it need outside knowledge?
- Could two of these options both be true at once?
- Is there a realistic input none of these options would cover?
- Is this a rating question disguised as a yes/no?
- Are these rating levels actually in order?
- Do the criteria contradict the instructions?

This costs one API call per question and only runs when you ask for it (`--semantic`).

**The two layers are deliberately different.** The free one is *aggressive* — it flags every Choice
missing an escape hatch, including ones that are fine, because it can't know. The paid one is
*careful* — it only gets asked the questions that genuinely need thought. Cheap-and-noisy filters
first; expensive-and-accurate resolves the leftovers.

### 4. A test set that proves the linter works

This is the part most tools skip. wellposed ships the 40 questions we measured, hand-labelled, plus the
grading rubric written **before** anything was generated, so the goalposts couldn't move afterward.

Run `wellposed eval` and it scores itself:

```
  hand label                      n   caught
  ----------------------------------------------
  no-escape-hatch                 8      8/8   fully covered
  degree-as-noul                  3      3/3   fully covered
  bundled-judgments               2      1/2   partial
  overlapping-choice-options      1      0/1   deferred to the semantic layer
  unanswerable-from-state         2      0/2   deferred to the semantic layer

  recall    12/16 = 75%      precision  12/14 = 86%
```

In plain terms: **it catches 75% of the known problems, and 86% of what it flags is genuinely a
problem.** Those numbers are computed live, not typed into this README. If a future change makes the
linter worse, the number drops and you see it.

Plus 21 unit tests. Three exist specifically because we sent those exact broken requests to the real
API and recorded what it said.

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

Node ≥ 18, zero dependencies. No API key needed for the structural checks.

## Use

If you installed as a skill rather than from npm, the CLI lives inside the skill directory. Locate it
with `find ~/.claude/plugins ~/.agents/skills ~/.codex/skills -name wellposed.mjs -path '*wellposed/scripts/*' | head -1`
and call `node <that path>` wherever `wellposed` appears below.

```sh
wellposed lint request.json               # structural: free, offline, no API key
wellposed lint request.json --semantic    # + jev-on-jev checks (needs TYPESAFE_API_KEY)
wellposed lint - < request.json           # reads stdin
wellposed rules                           # every rule and where it comes from
wellposed eval                            # score the linter against the labelled corpus
```

Exit code is `1` when errors are found, so it drops into CI unchanged. `--json` for machine output,
`--max-warnings <n>` to fail on warnings too.

Disagree with a rule? Turn it off. If your option list really is exhaustive, that warning is noise and
you should silence it:

```json
{ "rules": { "choice/no-escape-hatch": "off" } }
```

```sh
wellposed lint request.json --config wellposed.config.json
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
- **The semantic layer ranks; it does not cleanly separate.** Clear defects scored 0.94–0.96, contested
  ones 0.60–0.74. Trust the high end, review the middle. Thresholds are tunable for a reason.
- **`choice/no-escape-hatch` over-flags by design.** Whether "none of these" is reachable is a question
  about meaning. If your option set really is exhaustive, turn the rule off.
- **One label was corrected after the fact**, and the correction is recorded in
  [`corpus.json`](skills/wellposed/eval/corpus.json) under `corrections` rather than quietly applied.
- **Rules cite their source.** `verified` means reproduced against the live API; everything else cites
  a docs page. `wellposed rules` shows which is which.
- Codex behaviour was verified against Codex as of **2026-09-17**. Older builds may need
  `codex --enable skills`.

## Not affiliated with TypeSafe

This is an independent tool. TypeSafe, System One and jev are theirs; the rules here are drawn from
their public documentation, which is the authority whenever it and this tool disagree — in particular
[jev-1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), the most useful page in the
docs and the one most often skipped.

## Development

```sh
npm test                 # 21 unit tests, zero dependencies
npm run eval             # score the linter against the corpus
npm run lint:example     # lint the bundled example
```

MIT.
