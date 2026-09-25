/**
 * wellposed — semantic lint for TypeSafe System One (jev) requests.
 *
 * Layer 3. Everything here costs a model call, so it only asks what the
 * structural rules provably cannot answer.
 *
 * The design is a cascade, which is the whole point:
 *
 *   structural (free)  flags EVERY Choice with no none-of-the-above option.
 *                      Measured 100% recall, 86% precision — it over-flags,
 *                      because whether "none of these" is reachable is a
 *                      question about meaning, not about JSON.
 *   semantic (1 call)  asks jev whether none-of-these is actually reachable,
 *                      and drops the false positives.
 *
 * So the cheap layer is tuned for recall and the expensive layer supplies
 * precision, and jev is only consulted about the handful of things that
 * genuinely require judgment. This is TypeSafe's own cascade pattern applied
 * to TypeSafe requests.
 *
 * Every check is a Noul, because each is a yes/no property of the question.
 * Per the docs a Noul returns P(yes) and carries no separate confidence, so
 * values near 0.5 mean genuine ambiguity — those become warnings rather than
 * failures instead of being silently rounded.
 */

import { textOf, applyOverrides } from './structural.mjs';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/**
 * Uncertain band. A Noul near 0.5 is genuine ambiguity, not a mild verdict, so
 * the middle routes to `info` rather than being rounded into a decision.
 * Bounds match the documented wording ("warn above 0.65, uncertain 0.35-0.65"):
 * strictly above HIGH warns, HIGH itself is uncertain. jev quantizes to two
 * decimals, so both endpoints occur in practice.
 */
export const LOW = 0.35;
// Lowered from 0.65 on 2026-09-21. The sweep that justified it was vacuous:
// negatives below LOW produced no finding, were recorded as null, and so counted
// as "no false alarm" at every threshold by construction.
//
// Re-measured 2026-09-24 with every answered probability recorded (29 of 35
// negatives scored; 6 gated off, correctly counted as not fired):
//   zero false alarms at every threshold from 0.35 to 0.80;
//   the first false alarm appears at 0.30 (one negative at pDefect 0.34);
//   at 0.50, recall 32/35 [78-97%], precision 32/32 [89-100%], Wilson 95%.
// So 0.50 stands, on a stated margin: the nearest negative sits 0.16 below it.
// 0.35 would buy two more true positives and leave a 0.01 margin, which is
// fitting 70 items rather than choosing a threshold.
export const HIGH = 0.50;
/** Request policy for the review calls. All overridable via opts. */
export const TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 2;
export const CONCURRENCY = 6;

/**
 * Each check: which primitives it applies to, the yes/no question to ask about
 * the question under review, and which answer indicates a defect.
 */
const hasCriteria = (q) => q?.criteria != null
  && (typeof q.criteria !== 'object' || Object.keys(q.criteria).length > 0);

/**
 * Retired ids that still work in a config file. Setting one sets every check it
 * was split into, unless that check is also set explicitly.
 */
export const ALIASES = {
  'semantic/criteria-contradict-instructions': [
    'semantic/criteria-off-topic', 'semantic/criteria-polarity-inverted', 'semantic/levels-reversed',
  ],
};
export function expandAliases(rules) {
  if (!rules) return rules;
  const out = { ...rules };
  for (const [old, now] of Object.entries(ALIASES)) {
    if (!(old in rules)) continue;
    for (const id of now) if (!(id in rules)) out[id] = rules[old];
    delete out[old];
  }
  return out;
}

export const CHECKS = [
  {
    // Restored to the v0.5.0 wording on purpose. A structured rewrite with
    // {question, inspect, focus} and {what, examples} caught the one crossed-option
    // miss (#5: 0.37 -> 0.78) but lost three plain "X and Y" positives (#1, #2, #4
    // fell to 0.37-0.47): its "this is still one judgment" example was a
    // multi-clause question, and that moved the boundary. 4/5 -> 2/5. Examples
    // near the boundary pull true positives across it.
    id: 'semantic/bundled-judgments',
    applies: ['noul', 'choice', 'score'],
    defectWhen: false, // a NO to "is this exactly one judgment" is the defect
    instructions:
      'Does `question.instructions` ask for exactly ONE judgment? Answer no if it bundles two or more conditions ' +
      'that a reader could answer differently from each other — for example asking whether something is both urgent ' +
      'and about billing, or whether a person asked about three separate topics. Answer yes if it is a single ' +
      'coherent judgment, even if that judgment is nuanced or has several clauses describing one property.',
    criteria: {
      true: 'The question asks for one judgment that cannot be split into independently useful answers.',
      false: 'The question bundles two or more independent judgments, so a single answer cannot say which one drove it.',
    },
    message: (p) => `asks for more than one judgment at once (P(single judgment)=${p.toFixed(2)})`,
    fix: 'Split into separate questions and combine them in code. Independent questions in one request run in parallel at no extra round trip.',
    doc: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
  },
  {
    id: 'semantic/unanswerable-from-state',
    applies: ['noul', 'choice', 'score'],
    defectWhen: false,
    needsState: true,
    instructions:
      'Can `question.instructions` be answered using ONLY the information in `state`? Answer no if answering it would ' +
      'require looking something up elsewhere, knowing what happens in the future, or knowing private facts that are ' +
      'not present in `state`.',
    criteria: {
      true: 'Everything needed to answer is present in the given state.',
      false: 'Answering requires external lookup, future knowledge, or facts absent from the state.',
    },
    message: (p) => `may not be answerable from the state alone (P(answerable)=${p.toFixed(2)})`,
    fix: 'Retrieve the missing evidence in code and put it in state, or drop the question.',
    doc: 'https://docs.typesafe.ai/concepts/state',
  },
  {
    id: 'semantic/options-not-exclusive',
    applies: ['choice'],
    defectWhen: true, // a YES to "can two be true at once" is the defect
    instructions:
      'Could two or more of the options listed in `question.criteria` be simultaneously true of the same input? ' +
      'Answer yes if any two options overlap in meaning or could both fairly describe one case.',
    criteria: {
      true: 'At least two options overlap, so probability mass would be split between them.',
      false: 'The options are mutually exclusive; at most one can describe any given input.',
    },
    message: (p) => `has overlapping options (P(overlap)=${p.toFixed(2)}), which splits probability mass and makes the top pick unstable`,
    fix: 'Merge or re-cut the overlapping options so at most one can apply.',
    doc: 'https://docs.typesafe.ai/primitives/choice',
  },
  {
    id: 'semantic/escape-hatch-needed',
    applies: ['choice'],
    defectWhen: true,
    // Only asked when the structural layer already found no escape hatch.
    gatedOn: 'choice/no-escape-hatch',
    instructions:
      'Is there a realistic input for which NONE of the options listed in `question.criteria` would be correct? ' +
      'Consider the kind of input described by `question.instructions` and by `state`. Answer yes if a plausible ' +
      'real input could fall outside every listed option.',
    criteria: {
      true: 'A realistic input exists that none of the listed options correctly describes.',
      false: 'The listed options exhaustively cover every realistic input.',
    },
    message: (p) => `needs a none-of-the-above option: a realistic input could fall outside every listed option (P=${p.toFixed(2)}). Without one jev must still pick, and it does so at high confidence`,
    fix: 'Add e.g. {"other": "A case that fits none of the above"}.',
    doc: 'https://docs.typesafe.ai/primitives/choice',
  },
  {
    id: 'semantic/degree-as-noul',
    applies: ['noul'],
    defectWhen: true,
    // Measured 0/5 recall in its first form, which asked whether the question
    // says "how much". The real failure class is phrased as a yes/no over a
    // GRADABLE property — "is this pain severe", "is this PR risky" — where the
    // surface form is a condition but the underlying property is a matter of
    // degree with no stated cutoff.
    instructions:
      'Does `question.instructions` turn on a property that is a matter of DEGREE — severe, risky, strong, ' +
      'reliable, toxic, significant, good — where reasonable people would put the cutoff in different places, ' +
      'AND neither the instructions nor `question.criteria` say where that line falls? Include questions ' +
      'phrased as a yes/no about such a property, not only ones that literally ask "how much".',
    criteria: {
      true: 'The property varies by degree and no threshold is given, so a yes/no answer hides where the line was drawn.',
      false: 'The condition is sharply defined, or the criteria state explicitly where the cutoff falls.',
    },
    message: (p) => `is a degree question asked as a Noul (P=${p.toFixed(2)}); P(yes) cannot express "how much"`,
    fix: 'Use a Score with ordered, concrete levels, or restate as a sharp yes/no condition.',
    doc: 'https://docs.typesafe.ai/primitives/score',
  },
  {
    id: 'semantic/levels-unordered',
    applies: ['score'],
    defectWhen: false,
    instructions:
      'Are the levels in `question.criteria` arranged in a single consistent order, from least to most of the ' +
      'property named in `question.instructions`?',
    criteria: {
      true: 'The levels form one consistent progression from least to most.',
      false: 'The levels are out of order, or do not lie on a single dimension.',
    },
    message: (p) => `has levels that may not be in a consistent order (P(ordered)=${p.toFixed(2)})`,
    fix: 'Reorder the levels so they run from least to most along one dimension.',
    doc: 'https://docs.typesafe.ai/primitives/score',
  },
  // These three replace `semantic/criteria-contradict-instructions`, which asked
  // one Noul to judge "a different property, OR an inverted meaning" — two
  // judgments in one question, the defect this tool exists to flag. It was the
  // weakest check (3/5), and a reversed Score scale fitted neither half (p=0.08).
  {
    id: 'semantic/criteria-off-topic',
    applies: ['noul', 'choice', 'score'],
    defectWhen: true,
    when: (q) => hasCriteria(q),
    instructions: {
      question: 'Do the descriptions in `question.criteria` define a DIFFERENT property from the one `question.instructions` asks about?',
      inspect: 'question.instructions and question.criteria',
      focus: 'Compare what is being judged, not how it is worded. Each description must say what the property ' +
        'IS for that answer. One that describes only an action to take, or an outcome, without defining the ' +
        'property, is off topic.',
    },
    criteria: {
      true: {
        what: 'Answering by the descriptions would decide some other property than the one asked about.',
        examples: [
          'Asks whether an invoice is overdue; the descriptions define whether the vendor is new',
          'Asks for the language of a document; the options describe how long it is',
        ],
      },
      false: {
        what: 'Each description defines, refines, or gives the conditions for the property that was asked about.',
        examples: [
          'Asks whether a warranty claim is valid; the descriptions list what makes a claim valid or invalid',
          'Asks for a document category; each option says what belongs in it',
        ],
      },
    },
    message: (p) => `has criteria that define a different property from the one its instructions ask about (P=${p.toFixed(2)})`,
    fix: 'Rewrite the criteria so each one describes the property the instructions ask about — or ask about the property the criteria describe.',
    doc: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
  },
  {
    id: 'semantic/criteria-polarity-inverted',
    applies: ['noul'],
    defectWhen: true,
    when: (q) => q?.criteria != null && typeof q.criteria === 'object' && q.criteria.true != null,
    instructions: {
      question: 'Does `question.criteria.true` describe the situation in which the answer to `question.instructions` is NO?',
      inspect: 'question.instructions, question.criteria.true and question.criteria.false',
      focus: 'Ignore negative wording on its own: a description can be written entirely in negations and still ' +
        'describe the yes case. Judge only which answer the true description corresponds to.',
    },
    criteria: {
      true: {
        what: 'The true description is the case where the question should be answered no, so the mapping is flipped.',
        examples: [
          'Asks whether an order should ship today; true describes holding it back',
          'Asks whether a loan is approved; true describes the application being declined',
        ],
      },
      false: {
        what: 'The true description is the case where the question should be answered yes, however it is worded.',
        examples: [
          'Asks whether an account is dormant; true describes no logins for 90 days',
          'Asks whether a column is safe to drop; true describes it having no readers and no writers',
        ],
      },
    },
    message: (p) => `has criteria.true describing the "no" case, so P(yes) means the opposite of what it seems (P=${p.toFixed(2)})`,
    fix: 'Swap the true and false descriptions, or reword the instructions so a yes means what criteria.true describes.',
    doc: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
  },
  {
    id: 'semantic/levels-reversed',
    applies: ['score'],
    defectWhen: true,
    when: (q) => Array.isArray(q?.criteria) && q.criteria.length >= 2,
    instructions: {
      question: 'Do the levels in `question.criteria`, taken in the order listed, run in the OPPOSITE direction to the order `question.instructions` asks for?',
      inspect: 'question.instructions and the order of question.criteria',
      focus: 'Judge direction only. If the instructions state no order, answer no. A list that is jumbled rather ' +
        'than reversed is a different problem: answer no for that too.',
    },
    criteria: {
      true: {
        what: 'The instructions ask for one direction and the listed levels run the other way.',
        examples: [
          'Asks for the smallest impact first; the first level listed describes the largest impact',
          'Asks to rate from lowest to highest risk; the list opens with the highest risk',
        ],
      },
      false: {
        what: 'The levels run in the stated direction, or the instructions state no direction.',
        examples: [
          'Asks for the smallest impact first; the first level describes the smallest impact',
          'Asks how serious an issue is without stating an order',
        ],
      },
    },
    message: (p) => `has levels running opposite to the direction its instructions state, so the score index reads backwards (P=${p.toFixed(2)})`,
    fix: 'Reverse the level list so it runs in the direction the instructions state, or change the instructions to match.',
    doc: 'https://docs.typesafe.ai/primitives/score',
  },
];

/** Build the meta-request that reviews ONE question. */
export function buildReviewRequest(id, q, { state, model = DEFAULT_MODEL, structuralRules = new Set() } = {}) {
  const checks = CHECKS.filter((c) =>
    c.applies.includes(q?.type)
    && (!c.gatedOn || structuralRules.has(c.gatedOn))
    // `needsState` was declared and never read: a request with no state handed
    // the reviewer the string "null" and was billed for the answer anyway.
    && (!c.needsState || (state != null && textOf(state).trim() !== ''))
    // A check that cannot apply to this question (e.g. polarity with no criteria)
    // is not asked, so it is neither billed nor able to fire on nothing.
    && (!c.when || c.when(q)));
  if (!checks.length) return { request: null, checks };

  // Six of the seven checks are about the QUESTION, so a long state is only
  // distraction and measurably costs accuracy. `unanswerable-from-state` is the
  // exception: truncating its evidence made it report that evidence was missing
  // when wellposed had removed it. That one gets the full state.
  const needsFullState = checks.some((c) => c.needsState);
  const reviewState = {
    question: {
      type: q.type,
      instructions: textOf(q.instructions),
      ...(q.criteria != null ? { criteria: q.criteria } : {}),
    },
    state: needsFullState ? (state ?? null) : truncate(state, 2000),
  };

  const questions = {};
  for (const c of checks) questions[c.id] = { type: 'noul', instructions: c.instructions, criteria: c.criteria };
  return { request: { state: reviewState, model, questions }, checks };
}

function truncate(v, n) {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s == null ? null : s.length <= n ? s : `${s.slice(0, n)}… [truncated, ${s.length} chars total]`;
}

/**
 * Run the semantic checks for a whole request.
 *
 * @param {object} req  the System One request to review
 * @param {object} opts
 * @param {string} opts.apiKey            defaults to process.env.TYPESAFE_API_KEY
 * @param {Set<string>} [opts.structuralByQuestion]  map questionId -> Set of structural rule ids already fired
 * @returns {Promise<{findings: Array, calls: number, usage: {input_tokens:number,output_tokens:number}}>}
 */
export async function semanticLint(req, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    const err = new Error('TYPESAFE_API_KEY is not set — semantic lint needs an API key. Run structural lint only, or export the key.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const model = opts.model ?? DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const entries = Object.entries(req.questions ?? {});
  const findings = [];
  // Every check that was asked and answered, whether or not it produced a
  // finding. A finding only exists at or above LOW, so anything scored from
  // findings alone never sees a confident "no defect" — which made an earlier
  // precision-vs-threshold sweep report 100% at every threshold by construction.
  const raw = [];
  const models = new Set();
  const usage = { input_tokens: 0, output_tokens: 0 };
  let calls = 0;

  const review = async ([id, q]) => {
    const structuralRules = opts.structuralByQuestion?.get(id) ?? new Set();
    const { request, checks } = buildReviewRequest(id, q, { state: req.state, model, structuralRules });
    if (!request) return [];
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          // Without this a stalled endpoint hangs the CLI with no output.
          signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
        });
      } catch (e) {
        // A connect timeout or reset throws instead of returning a response, and
        // used to end the whole run on one blip. Retry it like a 5xx.
        if (attempt >= (opts.maxRetries ?? MAX_RETRIES)) {
          const err = new Error(`semantic lint call failed for question "${id}": ${e.cause?.code ?? e.name} ${e.message}`);
          err.code = 'SEMANTIC_NETWORK';
          throw err;
        }
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      calls++;
      if (res.ok) break;
      if (attempt >= (opts.maxRetries ?? MAX_RETRIES)) break;
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`semantic lint call failed for question "${id}": HTTP ${res.status} ${body.slice(0, 200)}`);
      err.code = 'SEMANTIC_HTTP';
      throw err;
    }
    const json = await res.json();
    if (!json || typeof json.answers !== 'object' || json.answers === null) {
      const err = new Error(`semantic lint got HTTP 200 with no answers for question "${id}"`);
      err.code = 'SEMANTIC_SHAPE';
      throw err;
    }
    if (json.model) models.add(json.model);
    usage.input_tokens += json.usage?.input_tokens ?? 0;
    usage.output_tokens += json.usage?.output_tokens ?? 0;
    const out = [];
    let answered = 0;
    for (const c of checks) {
      const p = json.answers?.[c.id]?.noul;
      if (typeof p !== 'number') continue;
      answered++;
      const pDefect = c.defectWhen ? p : 1 - p;
      raw.push({ questionId: id, rule: c.id, p, pDefect });
      if (pDefect > HIGH) {
        out.push({ rule: c.id, severity: 'warn', questionId: id, probability: p, pDefect,
                   message: `Question "${id}" ${c.message(p)}.`, fix: c.fix, doc: c.doc });
      } else if (pDefect >= LOW) {
        out.push({ rule: c.id, severity: 'info', questionId: id, probability: p, pDefect,
                   message: `Question "${id}" — uncertain: ${c.message(p)}. jev is near 0.5 here, which means genuine ambiguity rather than a mild verdict.`,
                   fix: c.fix, doc: c.doc });
      }
    }
    // Both levels-reversed and levels-unordered can fire on one scale, and both are
    // reported. An earlier version dropped levels-unordered whenever levels-reversed
    // fired, to avoid a duplicate on clean reversals. The held-out set (#28) showed
    // levels-reversed firing on a JUMBLED scale, where that policy hid the correct
    // diagnosis and kept the wrong one. Two warnings is noise; a hidden right answer
    // is worse.
    if (checks.length && answered === 0) {
      const err = new Error(`semantic lint: none of the ${checks.length} checks for "${id}" came back`);
      err.code = 'SEMANTIC_SHAPE';
      throw err;
    }
    return out;
  };

  // One request per reviewed question, deliberately — although TypeSafe's fan-out
  // guidance says to put everything in one request. Measured 2026-09-24 on 20
  // corpus items, per-question vs ten reviews per call: batching saved only 14% of
  // input tokens (the docs' ~12x comes from re-sending a LARGE shared state; a
  // review state is small by design), scored verdicts were identical (19/20 each),
  // but individual scores moved by up to 0.51 and 3 of 99 flipped at 0.50 — other
  // questions in the same call leak into each answer, as the jaggedness page warns.
  // Revisit for requests whose state is large: unanswerable-from-state gets the
  // FULL state, so N questions over a long document send it N times.
  //
  // A bounded pool: one request per question fired at once meant 300 questions
  // became 300 simultaneous connections.
  const queue = entries.map((e, i) => [i, e]);
  const collected = [];
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      collected.push([next[0], await review(next[1])]);
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? CONCURRENCY, entries.length));
  await Promise.all(Array.from({ length: width }, worker));
  collected.sort((a, b) => a[0] - b[0]);
  for (const [, r] of collected) findings.push(...r);

  // M13: `--config` overrides were threaded in here and silently dropped, so
  // turning a semantic rule off did nothing and said nothing.
  return { findings: applyOverrides(findings, expandAliases(opts.rules)), calls, usage, raw, models: [...models] };
}
