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
export const HIGH = 0.65;
/** Request policy for the review calls. All overridable via opts. */
export const TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 2;
export const CONCURRENCY = 6;

/**
 * Each check: which primitives it applies to, the yes/no question to ask about
 * the question under review, and which answer indicates a defect.
 */
export const CHECKS = [
  {
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
    instructions:
      'Does `question.instructions` ask about a DEGREE or QUANTITY — how much, how severe, how many, a rating or a ' +
      'position on a scale — rather than a condition that is simply true or false?',
    criteria: {
      true: 'It asks for a degree, amount, or rating, which a yes/no probability cannot express.',
      false: 'It asks whether a condition holds, which is a genuine yes/no.',
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
  {
    id: 'semantic/criteria-contradict-instructions',
    applies: ['noul', 'choice', 'score'],
    defectWhen: true,
    instructions:
      'Do `question.criteria` describe something DIFFERENT from what `question.instructions` asks about, or invert ' +
      'its meaning — for example criteria where the true case describes a no?',
    criteria: {
      true: 'The criteria and the instructions ask for different things, or the mapping is inverted.',
      false: 'The criteria read as a direct extension of the instructions.',
    },
    message: (p) => `has criteria that appear to contradict its instructions (P=${p.toFixed(2)})`,
    fix: 'Align criteria with the instruction wording; jev-1.13 degrades when they disagree.',
    doc: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
  },
];

/** Build the meta-request that reviews ONE question. */
export function buildReviewRequest(id, q, { state, model = DEFAULT_MODEL, structuralRules = new Set() } = {}) {
  const checks = CHECKS.filter((c) =>
    c.applies.includes(q?.type)
    && (!c.gatedOn || structuralRules.has(c.gatedOn))
    // `needsState` was declared and never read: a request with no state handed
    // the reviewer the string "null" and was billed for the answer anyway.
    && (!c.needsState || (state != null && textOf(state).trim() !== '')));
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
  const usage = { input_tokens: 0, output_tokens: 0 };
  let calls = 0;

  const review = async ([id, q]) => {
    const structuralRules = opts.structuralByQuestion?.get(id) ?? new Set();
    const { request, checks } = buildReviewRequest(id, q, { state: req.state, model, structuralRules });
    if (!request) return [];
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        // Without this a stalled endpoint hangs the CLI with no output.
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
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
    usage.input_tokens += json.usage?.input_tokens ?? 0;
    usage.output_tokens += json.usage?.output_tokens ?? 0;
    const out = [];
    let answered = 0;
    for (const c of checks) {
      const p = json.answers?.[c.id]?.noul;
      if (typeof p !== 'number') continue;
      answered++;
      const pDefect = c.defectWhen ? p : 1 - p;
      if (pDefect > HIGH) {
        out.push({ rule: c.id, severity: 'warn', questionId: id, probability: p,
                   message: `Question "${id}" ${c.message(p)}.`, fix: c.fix, doc: c.doc });
      } else if (pDefect >= LOW) {
        out.push({ rule: c.id, severity: 'info', questionId: id, probability: p,
                   message: `Question "${id}" — uncertain: ${c.message(p)}. jev is near 0.5 here, which means genuine ambiguity rather than a mild verdict.`,
                   fix: c.fix, doc: c.doc });
      }
    }
    if (checks.length && answered === 0) {
      const err = new Error(`semantic lint: none of the ${checks.length} checks for "${id}" came back`);
      err.code = 'SEMANTIC_SHAPE';
      throw err;
    }
    return out;
  };

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
  return { findings: applyOverrides(findings, opts.rules), calls, usage };
}
