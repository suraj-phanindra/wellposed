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
