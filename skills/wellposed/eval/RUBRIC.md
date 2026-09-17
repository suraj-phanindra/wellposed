# Pre-registered rubric — jev question well-posedness
Written 2026-09-17 BEFORE any question was generated or inspected.

A question is ILL-POSED if it meets >=1 defect below. Defects are properties of the
question as written, judged without reference to who wrote it.

D1 DEGREE-AS-NOUL     Noul whose instructions ask "how much / what degree / on a scale",
                      i.e. the natural answer is a position on a dimension, not yes/no.
                      (Score is the correct primitive.)
D2 MULTI-JUDGMENT     One question bundling >=2 independently useful judgments
                      ("is it urgent AND about billing"). Answer is uninterpretable
                      because a single number cannot say which conjunct drove it.
D3 OVERLAPPING-CHOICE Choice whose criteria contain options that can both be true of the
                      same state (angry/furious; bug/defect). Splits probability mass.
D4 NO-ESCAPE-HATCH    Choice/Score over a state space where "none of these" is reachable,
                      but no no-match option exists. Forces a confident wrong pick.
D5 UNORDERED-SCORE    Score whose criteria levels are not monotonically ordered, or whose
                      levels are not mutually distinguishable situations.
D6 UNANSWERABLE       Question requires evidence absent from the state (external lookup,
                      future knowledge, private facts).
D7 TYPE-MISMATCH      Any syntax/type error the API would reject (400/422).

WELL-POSED = none of D1-D7.

Pre-registered decision thresholds (set now, not after seeing the number):
  < 8%   -> do not build. Noise; a linter would misfire more than it catches.
  8-20%  -> marginal. Build only if defects concentrate in 1-2 auto-detectable categories.
  > 20%  -> build. Real, systematic, worth enforcement.

KNOWN LIMITATION, stated up front: the same model generates and labels. Self-grading
biases the rate DOWNWARD (I rationalize my own choices). Therefore:
  - a HIGH measured rate is strong evidence (found despite bias toward acquittal)
  - a LOW measured rate is WEAK evidence (indistinguishable from self-serving)
This asymmetry is why Phase 3 exists: each defect category gets an objective
behavioral probe against the live API, which does not depend on my judgment.
