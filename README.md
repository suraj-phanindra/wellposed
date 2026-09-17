# wellposed

**Lint TypeSafe System One (jev) requests before you send them.**

jev rejects malformed requests loudly and answers ill-posed ones confidently. `wellposed` exists for
the second half of that sentence.

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

## Why

Measured on 2026-09-17 against `jev-1.13`, over 40 requests generated from realistic intents and
labelled against a rubric written **before** anything was generated:

| | |
|---|---|
| syntax errors | **0 / 40** |
| semantically ill-posed | **16 / 40 (40%)** |
| Choice questions carrying a none-of-the-above option | **0 / 11** |

The API already catches every syntax error, with precise field paths. It catches none of the rest.

The sharpest case, reproduced live:

```
options: [meeting request, pricing question, support issue, introduction]
state:   "Please remove me from this mailing list. I never signed up."

  without an escape hatch  ->  'support issue'   confidence 1.00
  with    an escape hatch  ->  'other'           confidence 0.93
```

Maximally confident, and wrong. The usual mitigation — threshold on confidence, route the uncertain
cases to a human — **cannot see this failure**. That is the argument for checking the request instead
of the answer.

By contrast, a Choice with overlapping options (`angry` / `furious`) collapses confidence to 0.19 with
the top two near-tied. That one *is* catchable at runtime, so `wellposed` doesn't spend a model call
on it. The rules here are chosen by what confidence cannot catch.

Reproduce all of it with `wellposed eval`.

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

This copies the skill to `~/.agents/skills/wellposed` and links each agent's directory at it.
In Codex, invoke with `$wellposed`.

### By hand

Everything lives in one directory. Copy [`skills/wellposed/`](skills/wellposed/) anywhere your agent
reads skills from, or paste
[SKILL.md](https://raw.githubusercontent.com/suraj-phanindra/wellposed/main/skills/wellposed/SKILL.md)
into the conversation.

### CLI only, no agent

```sh
npx wellposed lint request.json
```

Node ≥ 18, zero dependencies. Nothing to install and no API key needed for the structural checks.

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

Silence a rule whose premise doesn't hold for you:

```json
{ "rules": { "choice/no-escape-hatch": "off" } }
```

```sh
wellposed lint request.json --config wellposed.config.json
```

A working example ships at [`examples/wellposed.config.json`](skills/wellposed/examples/wellposed.config.json).

## The four layers

| Layer | What it is | Cost |
|---|---|---|
| **1. Adapter** | [`SKILL.md`](skills/wellposed/SKILL.md) — turns intent into a well-posed request: state shape, primitive choice, the rules that matter | — |
| **2. Structural** | [`structural.mjs`](skills/wellposed/scripts/structural.mjs) — 21 rules decided from the request JSON alone | free, offline |
| **3. Semantic** | [`semantic.mjs`](skills/wellposed/scripts/semantic.mjs) — 7 jev-on-jev checks for what structure can't decide | 1 call/question |
| **4. Eval** | [`corpus.json`](skills/wellposed/eval/corpus.json) + [`agreement.mjs`](skills/wellposed/eval/agreement.mjs) — 40 labelled questions that score layers 2–3 | free, offline |

Layers 2 and 3 are a deliberate cascade. Structural is tuned for **recall** — it flags every Choice
without an escape hatch, and over-flags on purpose. Semantic supplies **precision**, and is only asked
the questions structure genuinely cannot answer: is "none of these" actually reachable, do the options
overlap, is this answerable from the state at all.

Current agreement with the hand labels:

```
  hand label                      n   caught
  ----------------------------------------------
  no-escape-hatch                 8      8/8   fully covered
  degree-as-noul                  3      3/3   fully covered
  bundled-judgments               2      1/2   partial
  overlapping-choice-options      1      0/1   deferred to Layer 3
  unanswerable-from-state         2      0/2   deferred to Layer 3

  recall    12/16 = 75%      precision  12/14 = 86%
```

Those numbers are printed by `wellposed eval`, not copied by hand. When they change, that's a
regression, which is the point of shipping the corpus.

## Honest limits

- **The corpus was generated and labelled by one model.** Self-grading biases the defect rate
  *downward*, so 40% is a floor, not a point estimate. The live behavioural probes exist precisely
  because they don't depend on that judgment.
- **The semantic layer ranks; it does not cleanly separate.** Clear defects scored 0.94–0.96, contested
  ones 0.60–0.74. Trust the high end, review the middle. Thresholds are tunable for a reason.
- **`choice/no-escape-hatch` over-flags by design.** Whether "none of these" is reachable is a question
  about meaning. If your option set really is exhaustive, turn the rule off — that's what the config is
  for.
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
