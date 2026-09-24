# Held-out validation — decision rules, fixed before any result

Written 2026-09-24, before the held-out set was generated or scored.

## Why

The three checks that replaced `semantic/criteria-contradict-instructions`
(`criteria-off-topic`, `criteria-polarity-inverted`, `levels-reversed`) were
designed after reading the five failures in `semantic-corpus.json`, and the
off-topic wording was changed after seeing item #63 move from 0.44 to 0.82. Their
in-corpus scores therefore cannot distinguish a working check from one fitted to
five items. `bundled-judgments` is validated too: its structured rewrite regressed
on the corpus and was reverted, so its current wording has only in-corpus evidence.

## The held-out set

- Written by generators that are told the defect in plain English and are
  forbidden from reading this repository, so the items cannot echo the checks'
  wording or copy the existing corpus.
- 10 items per check: 5 with the defect, 5 adversarial negatives that resemble it.
- Re-labelled blind by a second agent, not told the intended labels or how many
  are positive. Items where the two labels disagree are REPORTED, and scored
  under the generator's label; they are not silently dropped.
- Scored once, pinned to `jev-1.13.0`, at the shipped threshold (warn above 0.50).

## Decision rules, per check

| held-out result | action |
|---|---|
| precision >= 80% and recall >= 60% | keep as a warning; publish the numbers |
| precision >= 80%, recall < 60% | keep as a warning; publish the low recall plainly |
| precision < 80% | demote the check's findings to `info` (advisory) |

With 5 positives and 5 negatives per check, "80%" means at most one false alarm
among the negatives that fire, and "60%" means at least 3 of 5.

## What is not allowed after scoring

- No rewording of any check in response to held-out results. A reworded check
  needs a new held-out set; this one is spent once it is scored.
- No moving the threshold in response to held-out results.
- The held-out file is never merged into the tuning corpus.

---

## Result — scored once, 2026-09-24, `jev-1.13.0`, warn above 0.50

Rules above were committed in `e67f87e`; the unscored set in `e373cb8`. Neither
was edited after scoring. Labeller agreement 40/40 (same-model self-consistency,
not ground truth).

| check | recall | precision | decision under the rules |
|---|---|---|---|
| `criteria-polarity-inverted` | 5/5 | 5/5 | keep as a warning |
| `criteria-off-topic` | 4/5 | 4/4 | keep as a warning |
| `levels-reversed` | 4/5 | 4/5 | keep as a warning (precision exactly 80%) |
| `bundled-judgments` | 3/5 | 3/3 | keep as a warning (recall exactly 60%) |
| **all four** | **16/20 = 80%** [58–92%] | **16/17 = 94%** [73–99%] | Wilson 95% |

For comparison, the same checks scored 9/10 on the tuning corpus they were
designed against. The held-out figure is the one to quote.

### What the misses and the false alarm show

- `levels-reversed` false alarm (#28): the scale is **jumbled**, not reversed, and
  the check fired anyway. The question genuinely is broken — `levels-unordered`
  is the right diagnosis. This exposed a reporting policy added the same day that
  dropped `levels-unordered` whenever `levels-reversed` fired, which here hid the
  correct warning. That policy was removed; it changes no scored number above.
- `levels-reversed` miss (#23): a rubric listed Beginning → Exemplary while the
  instructions said strongest first. `levels-unordered` still warned (0.61), so the
  user is told something is wrong, with a less precise diagnosis.
- `bundled-judgments` misses (#32, #33): in both, the bundling lives in the
  **options or criteria**, not the instructions — a 2×2 grid of shipping options,
  and a `true` description that ORs two unrelated conditions. The current wording
  reads the instructions only. A structured rewrite that also read the options was
  tried on the tuning corpus and lost more than it gained, so this is a known,
  measured gap rather than an oversight.
- `criteria-off-topic` miss (#5): options labelled with learning objectives whose
  descriptions define cognitive level instead. Deliberately subtle.

Per the rules, no check was reworded and no threshold moved in response.
