---
name: wellposed
description: >
  Turn a natural-language intent into a well-posed TypeSafe System One (jev) request, then lint it
  before sending. Use when writing, reviewing, or debugging jev requests — choosing between Choice,
  Score and Noul, building state, writing instructions and criteria, or working out why an answer
  looks confident but wrong. Also use when a jev answer is suspect and you need to tell a bad
  question from a bad model. Not for general LLM prompting, and not for providers other than
  TypeSafe.
metadata:
  short-description: Write and lint jev requests that mean what you think they mean.
  version: 0.6.1
  homepage: https://github.com/suraj-phanindra/wellposed
---

# wellposed

jev rejects malformed requests loudly and answers ill-posed ones confidently. That asymmetry is the
whole problem this skill exists for.

Measured on 2026-09-17 against `jev-1.13`, over 40 requests generated from realistic intents:

| | |
|---|---|
| syntax errors | **0 / 40** — the API's own 400/422s already cover this |
| semantically ill-posed | **16 / 40 (40%)** |
| Choice questions carrying a none-of-the-above option | **0 / 11** |
| a Choice with no escape hatch, given an input none of its options covered | **wrong answer at confidence 1.00** |

That last row is why linting happens *before* the call. The standard mitigation — gate on confidence,
send the uncertain ones to a human — cannot see this failure, because the model is maximally confident
in the wrong answer.

## Build the request

### 1. State: named fields, not a blob

State is the material you hand jev before asking it to judge. It can be a string, but prefer an object
so each part has a name:

```json
{
  "ticket": {"subject": "Duplicate charge", "messages": [{"from": "customer", "text": "…"}]},
  "order": {"id": "A-104", "charges": [{"amount_usd": 49}, {"amount_usd": 49}]},
  "refund_policy": "Duplicate charges are eligible for a refund."
}
```

Then **reference state by path in backticks** from the instructions — `` `ticket.messages[0].text` ``,
`` `order.charges` ``. This is TypeSafe's own convention (their playground seeds every primitive with
one: ``Is `food` a sandwich?``), and it buys something concrete: a reference that does not resolve is
a *provable* bug, so the linter can catch it with no model call and no judgment.

Send only what the question needs. Accuracy falls as state grows with unrelated content — jev's own
jaggedness notes call this out, and unreferenced state fields are the cheapest signal for it.

### 2. Pick the primitive by what the answer means

A request has exactly three top-level fields: `state`, `model` (`"jev-latest"`, or a pinned version — see below), and `questions` — a
map from ids you choose to question objects. A complete worked request ships next to this file at
`examples/support-ticket.json`.

`jev-latest` is a moving alias. Once you have tuned thresholds against real answers, pin the model so a
new release cannot quietly move them — and use the **full** version: `"jev-1.13.0"` works, `"jev-1.13"`
is rejected with `Unknown model`, and `/v1/models` lists only the aliases, so the pinned id isn't
discoverable there. The response's `model` field tells you which version actually served you.

The three primitives take **different criteria shapes**, and the API rejects the wrong one outright:

| Primitive | `criteria` shape | Wrong shape gives |
|---|---|---|
| **Noul** | `{"true": "...", "false": "..."}`, optional | 422 on an array; any other key (`"yes"`, `"no"`) is **accepted and silently dropped** |
| **Choice** | `{"option": "description", ...}` — a map | 422 `dict_type` on an array |
| **Score** | `["lowest", ..., "highest"]` — an ordered array, 2–10 levels | 422 `list_type` on an object |

| The answer is | Use | Watch for |
|---|---|---|
| one of a known, unordered set | **Choice** | returns the pick, a probability per option, and `confidence` |
| a position on an ordered dimension | **Score** | levels must be ordered and describe concrete situations |
| whether a condition holds | **Noul** | returns P(yes) only — **no separate `confidence` field** |

A Noul near 0.5 means genuine ambiguity between yes and no. It does **not** mean "medium". If you
find yourself reading a Noul as an intensity, you wanted a Score.

### 3. The four rules that account for most defects

1. **Give every Choice an escape hatch** unless the options are genuinely exhaustive.
   `{"other": "A case that fits none of the above"}`. This is the single highest-value habit here.
2. **One judgment per question.** "Is this urgent *and* about billing?" produces one number that
   cannot tell you which half drove it. Split it; independent questions in one request run in
   parallel at no extra round trip.
3. **Keep code's work in code.** jev does not count, do arithmetic, or compare dates reliably.
   Extract with a Choice over enumerated options (including "not stated"), then compute in code.
4. **Write the exact condition.** jev reads instructions literally. When you catch a wrong answer and
   start explaining what you *really* meant, that explanation is the missing half of the instruction.

### 4. Batch

jev ingests state once and answers all questions in parallel. Putting independent questions in one
request instead of several is documented at roughly 12x cheaper and 10x faster. Include speculative
questions and let your code ignore the branches it does not need.

Limits: 64k tokens for state + all questions together, 32k for state + the longest single question.

## Lint it before you send it

```sh
npx wellposed lint request.json              # free, offline, no API key
npx wellposed lint requests/*.json           # several files; fails if any has an error
npx wellposed lint request.json --semantic   # + jev-on-jev checks (needs TYPESAFE_API_KEY)
npx wellposed rules                          # every rule and where it comes from
npx wellposed eval                           # score the linter against the labelled corpus
```

No network? The CLI also ships inside this skill directory, but your shell's working directory is the
user's project, not this skill's, so a bare `node scripts/wellposed.mjs` will not resolve. Locate it:

```sh
WP=$(find ~/.claude/plugins ~/.agents/skills ~/.codex/skills .agents/skills \
        -name wellposed.mjs -path '*wellposed/scripts/*' 2>/dev/null | head -1)
node "$WP" lint request.json
```

Never rely on `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_SKILL_DIR}` — they expand to nothing outside
Claude Code, which is precisely the case this skill has to survive.

The two layers do different jobs, and the split is deliberate:

- **Structural** (free, offline) is tuned for **recall**. It flags every Choice with no escape hatch,
  every broken state path, every documented jev weak spot. Measured 100% recall on the escape-hatch
  class, 92% precision overall — it over-flags on purpose.
- **Semantic** (one jev call per question) supplies **precision**, and only for what structure cannot
  decide: whether "none of these" is actually reachable, whether options overlap, whether the question
  is answerable from the state at all.

Findings carry `error` (the API will reject it, or the answer is provably meaningless), `warn` (a
documented failure mode), and `info` (advisory). Silence a rule whose premise does not hold for you:

```json
{"rules": {"choice/no-escape-hatch": "off"}}
```

passed as `--config wellposed.config.json`. The same file takes a `forbidden` list of field names or
dotted paths that must never appear in `state` — use it for credentials and personal data, since
`state` is sent to TypeSafe's API:

```json
{"forbidden": ["password", "api_key", "ssn", "card_number"]}
```

## Reading the answer

Read answers from the flat `answers` map, keyed by the question ids you chose — that is the only shape
common to both SDKs. Question ids are for your code; they are never sent to the model, so put the full
meaning in the instructions.

Only Choice and Score carry `confidence` and `probabilities`; Score also returns a `legend` mapping
level indices back to your labels. A Noul answer carries `type` and `noul` — a probability, with no
confidence or distribution beside it.
Confidence measures how concentrated the distribution is — not whether the workflow is correct, and
not permission to act. Typed output guarantees the interface, not the truth.

## When a jev answer looks wrong

Work in this order, because the cheap causes are also the common ones:

1. Lint the request. A structural finding explains most surprises.
2. Check the state actually contains the evidence, and that every backticked path resolves.
3. Re-read the instruction literally, as jev would, and ask whether the wrong answer is the correct
   answer to the question you actually wrote.
4. Only then suspect the model — and check it against the known jagged edges before concluding.

## Sources

Every rule cites TypeSafe's own documentation, and the measurements above are reproducible with
`wellposed eval`. Primary references: [primitives](https://docs.typesafe.ai/primitives),
[state](https://docs.typesafe.ai/concepts/state), [confidence](https://docs.typesafe.ai/confidence),
and [jev-1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), which is the single
most useful page and the one most often skipped.
