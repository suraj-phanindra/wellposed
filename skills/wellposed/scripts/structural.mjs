/**
 * wellposed — structural lint for TypeSafe System One (jev) requests.
 *
 * Zero dependencies, zero model calls, zero network. Everything here is decided
 * from the request JSON alone.
 *
 * Severity contract:
 *   error  the API rejects this, or the answer is provably meaningless.
 *          Every `error` marked [verified] was reproduced against the live
 *          jev-1.13 endpoint on 2026-09-17.
 *   warn   a documented jev-1.13 failure mode, or a defect measured to produce
 *          wrong answers. The request succeeds; the answer may be garbage.
 *   info   advisory. Style and cost, not correctness.
 *
 * Why structural checks exist at all: in a 40-question sample generated from
 * realistic intents, 42.5% were ill-posed but 0% had syntax errors. The
 * single largest defect class (missing none-of-the-above on a Choice, 47% of
 * all defects) is a *structural* property, and it fails at confidence 1.00 —
 * so runtime confidence gating cannot catch it. That is the case for linting
 * before the call rather than thresholding after it.
 */

export const PRIMITIVES = ['noul', 'choice', 'score'];

// Docs: "A Choice question accepts up to 255 options."
export const MAX_CHOICE_OPTIONS = 255;

// Verified live: 12 levels -> 400 "Too many score levels. Must have at most 10 levels."
export const MAX_SCORE_LEVELS = 10;

// Docs (jev-1.13 jaggedness): 64k tokens for all state + questions together;
// 32k for state + the longest single question.
export const CTX_TOTAL_TOKENS = 64_000;
export const CTX_STATE_PLUS_Q_TOKENS = 32_000;

/**
 * Token estimate, calibrated 2026-09-21 against the API's own reported
 * `usage.input_tokens` with the fixed request overhead subtracted:
 *
 *   plain prose      5.83 chars/token   (n=2, 2.1k and 6.3k chars)
 *   structured JSON  2.12 chars/token   (n=3, flat and nested records)
 *
 * The single 4.0 divisor this replaced over-counted prose by ~46% and
 * UNDER-counted structured state by ~1.9x, which is the dangerous direction
 * for a limit check: a request the linter called safe could be rejected.
 * The ratios below are rounded toward over-estimating for that reason, and
 * are exported so they can be re-fitted when the tokenizer changes.
 */
export const CHARS_PER_TOKEN_TEXT = 5.5;
export const CHARS_PER_TOKEN_JSON = 2.0;
/** Fixed per-request framing cost, measured with an empty state. */
export const REQUEST_OVERHEAD_TOKENS = 270;

export function estimateTokens(v, ratios = {}) {
  if (v == null) return 0;
  const text = ratios.text ?? CHARS_PER_TOKEN_TEXT;
  const json = ratios.json ?? CHARS_PER_TOKEN_JSON;
  if (typeof v === 'string') return Math.ceil(v.length / text);
  return Math.ceil(JSON.stringify(v).length / json);
}

/**
 * Normalise a Choice option before testing it for escape-hatch-ness.
 * snake_case, kebab-case, camelCase, trailing punctuation and parenthetical
 * qualifiers are all house styles in the wild — and TypeSafe's own Choice docs
 * use snake_case keys. Matching the raw string missed every one of them.
 */
export const normalizeOption = (s) => String(s)
  .replace(/\([^)]*\)/g, ' ')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_\-]+/g, ' ')
  .replace(/[^\p{L}\p{N}/' ]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const ESCAPE_HATCH = /^(other|others|none|none of the (above|these)|n ?\/? ?a|not applicable|does not apply|unknown|not stated|not specified|not provided|not mentioned|not given|unspecified|no match|no other|neither|unclear|cannot tell|can ?not tell|can't tell|undetermined|uncertain|indeterminate|ambiguous|something else)$/;
const ESCAPE_HATCH_DESC = /\b(none of (the )?(above|these|listed|options)|fits none|no(ne)? of the (other|listed)|does not fit|doesn'?t fit|not covered|anything else|any other)\b/i;

// --- jev-1.13 documented weak spots -----------------------------------------
// Every regex below is deliberately FRAMED: it fires when the question asks jev
// to DO the thing, not when the question merely mentions it. An earlier version
// matched bare keywords and flagged ordinary business English at a measured
// ~10-20% precision ("did not receive the invoice" tripped the double-negative
// rule on the letters "in" in "invoice").

// §2 "Math and Numbers" — jev does not count reliably.
const RE_COUNTING = /\b(how many|total number of|count (?:the|how many|each|all)|tally (?:the|up)|occurrences? of|number of times)\b/i;

// §2 — arithmetic belongs in code. Imperative or interrogative frames only;
// bare "average"/"percentage"/"ratio" are ordinary nouns.
const RE_ARITHMETIC = /\b(calculate|compute (?:the|a|an|how|total)|add up|sum (?:up )?the|work out the|what is the (?:total|sum|average|percentage|ratio)|divide the|multiply the|subtract the)\b/i;

// §3 — dates are read as text, not ordered quantities. "before"/"after" are
// ordinary prepositions ("after-hours maintenance"), so they need a date nearby.
const DATE_NOUN = '(?:date|dates|day|days|week|weeks|month|months|year|years|deadline|due|expiry|expiration|renewal|anniversary|timestamp|\\d{4}|\\d{1,2}[/-]\\d{1,2})';
const RE_DATE_COMPARE = new RegExp(
  '\\b(?:' +
    `(?:before|after|earlier than|later than|more recent than|older than|prior to)\\s+(?:\\w+\\s+){0,3}${DATE_NOUN}` +
    `|${DATE_NOUN}\\s+(?:\\w+\\s+){0,3}(?:before|after|earlier than|later than)` +
    `|within (?:the )?(?:last|next|past)\\s+(?:\\w+\\s+){0,2}${DATE_NOUN}` +
    '|how long ago' +
    '|days? (?:ago|apart|between)' +
    `|between\\s+.{0,25}\\band\\b.{0,25}${DATE_NOUN}` +
  ')\\b', 'i');

// "Hiding several judgments inside one question."
const RE_BUNDLED = /\b(\w+)\s+and\s+(?:also\s+)?(?:is|are|does|do|did|has|have|was|were|can|should|will)\b|,\s*and\s+(?:is|are|does|do|did|has|have|whether)\b/i;
// "Consider the subject, the body, and whether X" enumerates evidence for ONE
// judgment; so does quoted text. Both tripped the bundling heuristic.
const RE_BUNDLED_EXEMPT = /\b(consider|taking into account|based on|weigh(?:ing)?|using)\b[^.?!]{0,80},\s*and\b|["“][^"”]{0,160}["”]/i;

// §4 Indirection — double negatives cost accuracy. The prefix must actually
// negate: matching /(un|in|non|dis)\w+/ keys on spelling, so "invoice",
// "installed", "interested" and "insured" all counted as negations.
const NEGATING = [
  'un(?:able|available|likely|clear|willing|acceptable|resolved|paid|signed|verified',
  '|confirmed|answered|reasonable|satisfied|approved|documented|finished|changed)',
  '|in(?:complete|valid|eligible|active|accurate|sufficient|correct|consistent',
  '|applicable|admissible|conclusive|frequent)',
  '|non-?(?:compliant|refundable|negotiable|responsive|binding|standard|existent|disclosure)',
  '|dis(?:satisfied|approved|allowed|qualified|continued|puted|honest)',
].join('');
const RE_DOUBLE_NEG = new RegExp(
  `\\bnot\\b[^.?!]{0,40}\\b(?:${NEGATING})\\b` +
  '|\\bnever\\b[^.?!]{0,40}\\bnot\\b' +
  '|\\bnot\\b[^.?!]{0,40}\\bwithout\\b' +
  '|\\bno\\b[^.?!]{0,25}\\bnot\\b', 'i');

// Docs: a Noul is yes/no; degree belongs in a Score. But "rate" and "score" are
// also nouns, and "how much" is routinely embedded under a reporting verb
// ("Does the invoice state how much tax was charged?") where the question as a
// whole is a perfectly good yes/no.
const RE_DEGREE_CORE = /\b(how (urgent|severe|likely|well|strong|good|bad|relevant|confident|important|risky|complex|serious|difficult)|on a scale(?: of| from)?|to what extent|what (degree|level|extent) of)\b/i;
const RE_DEGREE_QUANT = /\bhow (much|many years)\b/i;
const RE_DEGREE_IMPERATIVE = /(?:^|[.;]\s*|please\s+)(rate|score|grade)\s+(the|this|how|each)\b/i;
const MATRIX_VERB = /\b(mention|state|say|said|ask|tell|told|report|include|indicate|specify|dispute|claim|note|record|show|list|describ)\w*\b/i;

// Two copular clauses joined by a conjunction, inside a single Score level.
const LEVEL_COPULA = '(?:is|are|was|were|has|have|had)';
const RE_TWO_CLAUSE = new RegExp(
  `\\b${LEVEL_COPULA}\\b[^,;:]{1,60}?\\b(?:and|but|while|yet)\\b[^,;:]{1,60}?\\b${LEVEL_COPULA}\\b`, 'i');

/** The subject of a level's first clause, with any "Label:" prefix removed. */
function levelSubject(level) {
  const s = level.replace(/^\s*[A-Za-z][\w ]{0,20}?\s*[:\u2014\u2013-]\s+/, '');
  const m = s.match(new RegExp(`^\\s*(.{1,40}?)\\s+\\b${LEVEL_COPULA}\\b`, 'i'));
  return m ? m[1].trim().toLowerCase() : null;
}

/**
 * Two independent dimensions crossed into one scale, e.g. every level reads
 * "description is X and coverage is Y". A mid-scale answer cannot say which
 * dimension moved.
 *
 * Deliberately NOT a keyword rule. Counting "and"/"or" in levels fires on nearly
 * every well-formed severity ladder, because concrete situations ("a task is
 * blocked and a workaround exists") routinely have two clauses that CO-vary. The
 * signature of the defect is structural: most levels have two clauses AND share
 * the same leading subject, so the scale is re-rating the same two things rather
 * than describing a different situation at each rung.
 */
export function crossedDimensions(levels) {
  if (!Array.isArray(levels) || levels.length < 3) return null;
  const strs = levels.filter((l) => typeof l === 'string');
  if (strs.length < 3) return null;
  const need = Math.max(2, Math.ceil(strs.length * 0.6));
  const twoClause = strs.filter((l) => RE_TWO_CLAUSE.test(l));
  if (twoClause.length < need) return null;
  const tally = new Map();
  for (const l of strs) {
    const subj = levelSubject(l);
    if (subj) tally.set(subj, (tally.get(subj) ?? 0) + 1);
  }
  const [subject, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return n >= need ? { subject, levels: n, of: strs.length } : null;
}

// A Noul criterion that opens with a negation, and instructions that are
// themselves negatively framed (in which case a negated `true` is correct).
const RE_NEG_START = /^\s*(?:no|not|none|never|nothing|without|neither|cannot|can'?t|isn'?t|doesn'?t|does not|is not)\b/i;
const RE_NEG_FRAMED = /\b(?:not|no|never|without|free of|absent|lacks?|missing|none)\b/i;
// Bare numbers, or a numeric range, and nothing else.
const RE_NUMERIC_LEVEL = /^\s*[-+]?\d+(?:\.\d+)?\s*(?:(?:-|\u2013|to)\s*[-+]?\d+(?:\.\d+)?)?\s*$/i;

/**
 * Paths in `state` that match a user-supplied deny-list. `state` is sent to a
 * third-party endpoint, so a field like `customer.card_number` is provable from
 * the JSON alone and invisible in the answer. An entry matches a key anywhere
 * (`card_number`), a dotted suffix (`billing.card_number`) or a full path.
 */
export function forbiddenPaths(state, forbidden) {
  if (!Array.isArray(forbidden) || !forbidden.length || state == null || typeof state !== 'object') return [];
  const deny = forbidden.map((f) => String(f).toLowerCase());
  const hits = new Set();
  const walk = (v, path, depth) => {
    if (depth > 12 || v == null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      const here = Array.isArray(v) ? `${path}[]` : (path ? `${path}.${k}` : k);
      if (!Array.isArray(v)) {
        const lp = here.toLowerCase(), lk = String(k).toLowerCase();
        if (deny.some((f) => lk === f || lp === f || lp.endsWith(`.${f}`))) hits.add(here);
      }
      walk(x, here, depth + 1);
    }
  };
  walk(state, '', 0);
  return [...hits];
}

/** Degree detection with context, returning the matched phrase or null. */
export function degreeMatch(text) {
  const core = text.match(RE_DEGREE_CORE);
  if (core) return core[0];
  const imp = text.match(RE_DEGREE_IMPERATIVE);
  if (imp) return imp[0].trim();
  const quant = text.match(RE_DEGREE_QUANT);
  if (quant) {
    // Suppress when a reporting verb governs it: the judgment is whether the
    // text SAYS how much, which is a genuine yes/no.
    const before = text.slice(0, quant.index);
    if (!MATRIX_VERB.test(before)) return quant[0];
  }
  return null;
}


/**
 * Every rule the engine can emit, with its severity and where it comes from.
 * This is the single source of truth: `wellposed rules` renders it, and a test
 * asserts it matches the ids actually emitted, so the listing cannot drift.
 */
export const RULES = {
  'choice/criteria-wrong-type': { severity: 'error', source: 'docs: primitives/choice' },
  'choice/duplicate-options': { severity: 'error', source: 'degenerate' },
  'choice/empty-option': { severity: 'error', source: 'verified: jev returns an empty choice' },
  'choice/missing-criteria': { severity: 'error', source: 'docs: primitives/choice' },
  'choice/too-many-options': { severity: 'error', source: 'docs: max 255 options' },
  'context/over-state-plus-question': { severity: 'error', source: 'docs: 32k state+longest question' },
  'context/over-total': { severity: 'error', source: 'docs: 64k state+questions' },
  'instructions/wrong-type': { severity: 'error', source: 'verified: live API 422' },
  'noul/criteria-not-object': { severity: 'error', source: 'verified: live API 422' },
  'question/empty-key': { severity: 'error', source: 'verified: live API 400' },
  'question/invalid-type': { severity: 'error', source: 'docs: api reference' },
  'question/missing-instructions': { severity: 'error', source: 'verified: live API 400' },
  'question/missing-type': { severity: 'error', source: 'docs: api reference' },
  'question/not-an-object': { severity: 'error', source: 'malformed input' },
  'request/missing-model': { severity: 'error', source: 'docs: models' },
  'request/missing-state': { severity: 'error', source: 'docs: concepts/state' },
  'request/no-questions': { severity: 'error', source: 'docs: api reference' },
  'request/not-an-object': { severity: 'error', source: 'malformed input' },
  'score/criteria-wrong-type': { severity: 'error', source: 'docs: primitives/score' },
  'score/duplicate-levels': { severity: 'error', source: 'splits probability across identical rungs' },
  'score/missing-criteria': { severity: 'error', source: 'docs: primitives/score' },
  'score/too-few-levels': { severity: 'error', source: 'docs: primitives/score' },
  'score/too-many-levels': { severity: 'error', source: 'verified: live API 400 (max 10)' },
  'state/broken-path': { severity: 'error', source: 'deterministic: path does not resolve' },
  'state/forbidden-path': { severity: 'error', source: 'your config: deny-listed field names or paths' },
  'state/wrong-type': { severity: 'error', source: 'verified: live API 422' },
  'choice/degenerate': { severity: 'warn', source: 'answer is predetermined' },
  'choice/no-escape-hatch': { severity: 'warn', source: 'measured: wrong answer at confidence 1.00' },
  'context/near-total': { severity: 'warn', source: 'docs: 64k state+questions' },
  'jev/arithmetic': { severity: 'warn', source: 'jaggedness: keep math in code' },
  'jev/bundled-judgments': { severity: 'warn', source: 'jaggedness: one judgment per question' },
  'jev/counting': { severity: 'warn', source: 'jaggedness: jev does not count reliably' },
  'jev/date-comparison': { severity: 'warn', source: 'jaggedness: dates read as text' },
  'jev/double-negative': { severity: 'warn', source: 'jaggedness: indirection costs accuracy' },
  'noul/degree-question': { severity: 'warn', source: 'docs: use a Score for degree' },
  'noul/unexpected-criteria-keys': { severity: 'warn', source: 'only true/false are meaningful' },
  'question/id-only-semantics': { severity: 'warn', source: 'docs: the question key is never sent to the model' },
  'score/crossed-dimensions': { severity: 'warn', source: 'blind corpus: 1/1 caught, 0 of 26 other Score questions flagged' },
  'score/numeric-only-levels': { severity: 'warn', source: 'docs: numbers-only levels give nothing to match' },
  'noul/criteria-inverted': { severity: 'info', source: 'jaggedness: inverted true/false degrades answers' },
  'request/single-question': { severity: 'info', source: 'docs: batching is ~12x cheaper' },
  'score/bare-levels': { severity: 'info', source: 'docs: levels should be concrete situations' },
  'state/flat-string': { severity: 'info', source: 'docs: prefer named fields' },
  'state/unreferenced-fields': { severity: 'info', source: 'jaggedness: context rot' },
  'state/unresolved-reference': { severity: 'info', source: 'bare backtick, not a path' },
};

/** Flatten instructions (string | object | array) into searchable text. */
export function textOf(v, depth = 0, seen = new WeakSet()) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (depth > 12) return '';
  if (typeof v === 'object') {
    if (seen.has(v)) return '';
    seen.add(v);
    return Array.isArray(v)
      ? v.map((x) => textOf(x, depth + 1, seen)).join(' ')
      : Object.entries(v).map(([k, x]) => `${k} ${textOf(x, depth + 1, seen)}`).join(' ');
  }
  return String(v);
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function finding(rule, severity, message, { questionId, fix, doc } = {}) {
  return { rule, severity, message, questionId: questionId ?? null, fix: fix ?? null, doc: doc ?? null };
}

/**
 * Lint a single question.
 * @param {string} id  the question key (not sent to the model — docs are explicit)
 * @param {object} q   the question object
 */
export function lintQuestion(id, q, opts = {}) {
  const out = [];
  const at = { questionId: id };

  if (!isPlainObject(q)) {
    return [finding('question/not-an-object', 'error', `Question ${id} is not an object.`, at)];
  }

  // ---- type -------------------------------------------------------------
  if (!q.type) {
    out.push(finding('question/missing-type', 'error', `Question "${id}" has no "type".`, {
      ...at, fix: `Set type to one of: ${PRIMITIVES.join(', ')}.`,
    }));
  } else if (!PRIMITIVES.includes(q.type)) {
    out.push(finding('question/invalid-type', 'error', `Question "${id}" has type "${q.type}".`, {
      ...at, fix: `Use one of: ${PRIMITIVES.join(', ')}.`,
    }));
  }

  // ---- instructions -----------------------------------------------------
  const hasInstr = q.instructions != null && textOf(q.instructions).trim() !== '';
  const hasCriteria = q.criteria != null
    && (typeof q.criteria !== 'object' || Object.keys(q.criteria).length > 0);

  // [verified] live API 400: "Noul question must have criteria or instructions"
  if (!hasInstr && !hasCriteria) {
    out.push(finding('question/missing-instructions', 'error',
      `Question "${id}" has neither "instructions" nor "criteria".`, {
        ...at, fix: 'Add instructions stating the judgment to make.',
        doc: 'https://docs.typesafe.ai/api',
      }));
  }
  // [verified] live API 422: instructions must be string | object | array
  if (q.instructions != null && !['string', 'object'].includes(typeof q.instructions)) {
    out.push(finding('instructions/wrong-type', 'error',
      `Question "${id}" has instructions of type ${typeof q.instructions}; must be string, object, or array.`, {
        ...at, doc: 'https://docs.typesafe.ai/api',
      }));
  }

  const text = textOf(q.instructions);

  // [docs] The question key "is not sent to the underlying model and is not used
  // in inference." A two-word instruction with no criteria means the meaning
  // lives in the key — `refund_requested: "refund?"` — and jev sees only "refund?".
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const noCriteria = q.criteria == null
    || (typeof q.criteria === 'object' && Object.keys(q.criteria).length === 0);
  if (hasInstr && words < 3 && noCriteria) {
    out.push(finding('question/id-only-semantics', 'warn',
      `Question "${id}" has ${words}-word instructions ("${text.trim()}") and no criteria. The key "${id}" is never sent to the model, so jev sees only "${text.trim()}".`, {
        ...at,
        fix: 'Put the full condition in the instructions, or add criteria describing what each answer means.',
        doc: 'https://docs.typesafe.ai/api',
      }));
  }

  // ---- per-primitive shape ---------------------------------------------
  if (q.type === 'noul') {
    // [verified] live API 422 when criteria is a list
    if (q.criteria != null && !isPlainObject(q.criteria)) {
      out.push(finding('noul/criteria-not-object', 'error',
        `Noul "${id}" has ${Array.isArray(q.criteria) ? 'array' : typeof q.criteria} criteria; must be an object with "true"/"false" keys.`, {
          ...at, fix: 'Use {"true": "what a yes means", "false": "what a no means"}.',
          doc: 'https://docs.typesafe.ai/primitives/noul',
        }));
    } else if (isPlainObject(q.criteria)) {
      const bad = Object.keys(q.criteria).filter((k) => k !== 'true' && k !== 'false');
      if (bad.length) {
        out.push(finding('noul/unexpected-criteria-keys', 'warn',
          `Noul "${id}" has criteria keys ${JSON.stringify(bad)}; only "true" and "false" are meaningful.`, at));
      }
    }
    if (isPlainObject(q.criteria)) {
      const tt = textOf(q.criteria.true), ff = textOf(q.criteria.false);
      // jaggedness: "a Noul where true maps to no and false maps to yes will
      // perform worse", and code reading the probability then inverts every
      // threshold. Info, not warn: a negatively framed question ("Is the record
      // free of PII?") makes a negated `true` correct, and is skipped here.
      if (tt && ff && RE_NEG_START.test(tt) && !RE_NEG_START.test(ff) && !RE_NEG_FRAMED.test(text)) {
        out.push(finding('noul/criteria-inverted', 'info',
          `Noul "${id}" has criteria.true opening with a negation ("${tt.trim().slice(0, 50)}") while criteria.false does not. Check the polarity: P(yes) may mean the opposite of what your code expects.`, {
            ...at,
            fix: 'Make criteria.true describe the case the instructions ask about.',
            doc: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
          }));
      }
    }
    const degree = degreeMatch(text);
    if (degree) {
      out.push(finding('noul/degree-question', 'warn',
        `Noul "${id}" asks about degree ("${degree}"), but a Noul returns only P(yes).`, {
          ...at,
          fix: 'Use a Score with ordered, concrete levels, or restate as a sharp yes/no condition.',
          doc: 'https://docs.typesafe.ai/primitives/score',
        }));
    }
  }

  if (q.type === 'choice') {
    if (!hasCriteria) {
      out.push(finding('choice/missing-criteria', 'error', `Choice "${id}" has no criteria (options).`, {
        ...at, doc: 'https://docs.typesafe.ai/primitives/choice',
      }));
    } else if (!isPlainObject(q.criteria)) {
      // [verified] live API 422 dict_type on an array. Choice takes a MAP.
      out.push(finding('choice/criteria-wrong-type', 'error',
        `Choice "${id}" criteria must be an object mapping option -> description, e.g. {"billing": "...", "other": "Fits none of the above."}. An array is rejected by the API.`, {
          ...at, doc: 'https://docs.typesafe.ai/primitives/choice',
        }));
    } else {
      const opts = Object.keys(q.criteria);
      const blank = opts.filter((o) => String(o).trim() === '');
      if (blank.length) {
        out.push(finding('choice/empty-option', 'error',
          `Choice "${id}" has ${blank.length} empty or whitespace-only option name(s). jev can return them, and an empty string is falsy in your code.`, at));
      }

      if (opts.length > MAX_CHOICE_OPTIONS) {
        out.push(finding('choice/too-many-options', 'error',
          `Choice "${id}" has ${opts.length} options; the maximum is ${MAX_CHOICE_OPTIONS}.`, {
            ...at, doc: 'https://docs.typesafe.ai/primitives/choice',
          }));
      }
      if (opts.length < 2) {
        out.push(finding('choice/degenerate', 'warn',
          `Choice "${id}" has ${opts.length} option(s); the answer is predetermined.`, at));
      }
      const norm = opts.map((o) => String(o).trim().toLowerCase());
      const dupes = opts.filter((o, i) => norm.indexOf(norm[i]) !== i);
      if (dupes.length) {
        out.push(finding('choice/duplicate-options', 'error',
          `Choice "${id}" has duplicate options: ${JSON.stringify([...new Set(dupes)])}.`, at));
      }

      // The headline rule. Measured: 0 of 11 generated Choices had one, and a
      // Choice without one answered a not-covered input at confidence 1.00.
      const descs = Array.isArray(q.criteria) ? [] : Object.values(q.criteria).map((d) => textOf(d));
      const hasHatch = opts.some((o) => ESCAPE_HATCH.test(normalizeOption(o)))
        || descs.some((d) => ESCAPE_HATCH_DESC.test(d));
      if (!hasHatch && opts.length >= 2) {
        out.push(finding('choice/no-escape-hatch', 'warn',
          `Choice "${id}" has no "other"/"none of the above" option. If an input fits none of [${opts.slice(0, 6).join(', ')}${opts.length > 6 ? ', …' : ''}], jev must still pick one — measured at confidence 1.00 on a wrong answer, so confidence gating will not catch it.`, {
            ...at,
            fix: 'Add e.g. {"other": "A case that fits none of the above"} — or, if the options are genuinely exhaustive, suppress this rule.',
            doc: 'https://docs.typesafe.ai/primitives/choice',
          }));
      }
    }
  }

  if (q.type === 'score') {
    if (!hasCriteria) {
      out.push(finding('score/missing-criteria', 'error', `Score "${id}" has no criteria (levels).`, {
        ...at, doc: 'https://docs.typesafe.ai/primitives/score',
      }));
    } else {
      // [verified] live API 422 list_type on an object. Score takes an ARRAY,
      // because the order of the levels is the dimension being scored.
      const levels = Array.isArray(q.criteria) ? q.criteria.map((x) => textOf(x)) : null;
      if (levels == null) {
        out.push(finding('score/criteria-wrong-type', 'error',
          `Score "${id}" criteria must be an ordered array of levels, e.g. ["can wait weeks", "needs attention today"]. An object is rejected by the API.`, {
            ...at, doc: 'https://docs.typesafe.ai/primitives/score',
          }));
      } else {
        if (levels.length > MAX_SCORE_LEVELS) {
          out.push(finding('score/too-many-levels', 'error',
            `Score "${id}" has ${levels.length} levels; the maximum is ${MAX_SCORE_LEVELS}.`, {
              ...at, doc: 'https://docs.typesafe.ai/primitives/score',
            }));
        }
        const numericOnly = levels.length >= 2 && levels.every((l) => RE_NUMERIC_LEVEL.test(l));
        if (numericOnly) {
          out.push(finding('score/numeric-only-levels', 'warn',
            `Score "${id}" levels are numbers only (${JSON.stringify(levels.slice(0, 5))}). Each level is evaluated on its own and the model never sees its number or its neighbours, so it has nothing to match against and splits probability across them.`, {
              ...at,
              fix: 'Describe the concrete situation each level stands for, e.g. ["can wait weeks", "needs attention today"].',
              doc: 'https://docs.typesafe.ai/primitives/score',
            }));
        }
        const crossed = crossedDimensions(Array.isArray(q.criteria) ? q.criteria : []);
        if (crossed) {
          out.push(finding('score/crossed-dimensions', 'warn',
            `Score "${id}" re-rates "${crossed.subject}" plus something else at ${crossed.levels} of ${crossed.of} levels. Two properties that can vary independently are crossed into one scale, so a middle answer cannot say which one moved.`, {
              ...at,
              fix: 'Split into one Score per property and combine them in code; they run in parallel in the same request.',
              doc: 'https://docs.typesafe.ai/patterns/composite-scoring',
            }));
        }
        const ln = levels.map((l) => l.trim().toLowerCase());
        const dupL = levels.filter((l, i) => ln.indexOf(ln[i]) !== i);
        if (dupL.length) {
          out.push(finding('score/duplicate-levels', 'error',
            `Score "${id}" has duplicate levels: ${JSON.stringify([...new Set(dupL)])}. Probability splits across identical rungs, which lowers confidence for no reason.`, at));
        }
        if (levels.length < 2) {
          out.push(finding('score/too-few-levels', 'error',
            `Score "${id}" has ${levels.length} level(s); a Score needs at least 2 ordered levels.`, at));
        }
        // Docs: "Score levels must describe concrete situations and stand on
        // their own." Bare adjectives ("weak", "okay") do not.
        const bare = levels.filter((l) => l.trim().split(/\s+/).length < 2);
        if (bare.length >= 2 && bare.length / levels.length > 0.6) {
          out.push(finding('score/bare-levels', 'info',
            `Score "${id}" levels are single words (${JSON.stringify(bare.slice(0, 4))}). Levels should describe concrete, self-standing situations.`, {
              ...at,
              fix: 'e.g. ["can wait weeks", "should be handled this week", "needs attention today"].',
              doc: 'https://docs.typesafe.ai/primitives/score',
            }));
        }
      }
    }
  }

  // ---- jev-1.13 documented failure modes (any primitive) ----------------
  // These run over the INSTRUCTIONS only, not criteria text, deliberately.
  // Measured 2026-09-24: running them over all 131 Score levels in both corpora
  // found 0 real defects and 1 false positive (a well-formed ladder). Levels
  // legitimately carry counts and thresholds - "ESI 3: two or more resources",
  // "crisis: 180 mmHg or above" - because bucketing a quantity into named levels
  // IS the documented fix for asking jev to count. Scanning them would warn on
  // the corrected form of the very thing these rules exist to catch. The one
  // real criteria-level defect, crossed dimensions, has its own structural rule.
  for (const [re, rule, msg, fix] of [
    [RE_COUNTING, 'jev/counting', 'asks jev to count', 'Count in code: ask one question per item and sum the answers yourself.'],
    [RE_ARITHMETIC, 'jev/arithmetic', 'asks jev to do arithmetic', 'Keep the arithmetic in code; give jev the judgment only.'],
    [RE_DATE_COMPARE, 'jev/date-comparison', 'asks jev to compare or order dates', 'Extract date parts with a Choice (include "not stated"), then compare in code.'],
    [RE_BUNDLED, 'jev/bundled-judgments', 'appears to bundle several judgments into one question', 'Split into separate questions and combine them in code — they run in parallel at no extra round trip.'],
    [RE_DOUBLE_NEG, 'jev/double-negative', 'contains a double negative or indirection', 'Rewrite as a direct positive condition.'],
  ]) {
    if (rule === 'jev/bundled-judgments' && RE_BUNDLED_EXEMPT.test(text)) continue;
    // Bucketing a quantity into named Score levels is the documented fix for
    // asking jev to count, so the corrected form must not get the same warning.
    const bucketed = (rule === 'jev/counting' || rule === 'jev/arithmetic')
      && q.type === 'score' && Array.isArray(q.criteria) && q.criteria.length >= 2;
    if (re.test(text)) {
      // For phrase-triggered rules the matched words are the useful evidence;
      // for structural patterns they read as nonsense, so show the instruction.
      const quote = ['jev/bundled-judgments', 'jev/double-negative'].includes(rule)
        ? `"${text.trim().slice(0, 80)}${text.trim().length > 80 ? '…' : ''}"`
        : `"${firstMatch(re, text)}"`;
      out.push(finding(rule, bucketed ? 'info' : 'warn', bucketed
        ? `Question "${id}" ${msg}: ${quote}, but its Score levels bucket the answer, which is the documented mitigation. Check the levels are not themselves exact counts.`
        : `Question "${id}" ${msg}: ${quote}. jev-1.13 is documented to be unreliable here.`, {
        ...at, fix, doc: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
      }));
    }
  }

  return applyOverrides(out, opts.rules);
}

function firstMatch(re, s) {
  const m = s.match(re);
  return m ? m[0].trim() : '';
}


// ---------------------------------------------------------------------------
// State checks
//
// The docs tell you to reference nested state with backticked paths such as
// `ticket.messages[0].text`, and TypeSafe's own playground seeds every
// primitive with one (`Is `food` a sandwich?`). That convention is what makes
// these checks possible: once a question names the state it reads, a broken
// reference is a fact about the JSON, not a matter of opinion.
// ---------------------------------------------------------------------------

/** Pull backticked tokens that look like state paths out of instruction text. */
export function extractPaths(text) {
  const out = [];
  for (const m of String(text).matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim();
    // A path is dotted/bracketed identifiers. Anything with spaces or operators
    // is prose in backticks, not a reference — leave it alone.
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(raw)) out.push(raw);
  }
  return out;
}

/** Walk a dotted/bracketed path. Returns {found:boolean, at:string} */
export function resolvePath(root, path) {
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // A state key may legitimately contain a dot, so try the whole path as a
  // literal key before splitting it.
  if (root != null && typeof root === 'object' && has(root, path)) return { found: true, at: path };
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = root;
  const walked = [];
  for (const part of parts) {
    walked.push(part);
    if (cur == null || typeof cur !== 'object') return { found: false, at: walked.join('.') };
    const key = Array.isArray(cur) ? String(Number(part)) : part;
    // `in` walks the prototype chain, so `constructor` and `toString` resolved.
    if (!has(cur, key)) return { found: false, at: walked.join('.') };
    cur = cur[key];
  }
  return { found: true, at: path };
}

/**
 * Checks that need state and questions together.
 * Only runs when state is a JSON object/array — a plain-string state has no
 * named fields, so nothing here applies.
 */
export function lintState(state, questions, opts = {}) {
  const out = [];
  if (state == null) return out;

  const isStructured = typeof state === 'object';
  const allText = Object.values(questions).map((q) => textOf(q?.instructions) + ' ' + textOf(q?.criteria)).join(' \n ');

  // -- deny-listed fields: silent unless the user configures `forbidden` -----
  // Zero false positives by construction, since the list is the user's own.
  for (const path of forbiddenPaths(state, opts.forbidden)) {
    out.push(finding('state/forbidden-path', 'error',
      `State contains "${path}", which is on your forbidden list. State is sent to the TypeSafe API.`, {
        fix: 'Drop or redact the field in code before building the request.',
        doc: 'https://docs.typesafe.ai/concepts/state',
      }));
  }

  if (!isStructured) {
    // Docs: "Use an object for most requests so each part of the state has a
    // descriptive name and its relationships remain clear."
    const s = String(state);
    const parts = s.split(/\n{2,}|\r\n{2,}/).filter((x) => x.trim());
    if (s.length > 1200 && parts.length >= 3) {
      out.push(finding('state/flat-string', 'info',
        `State is a single ${s.length}-character string with ${parts.length} distinct blocks. Named JSON fields let questions reference parts by path and make context rot easier to spot.`, {
          fix: 'Split into an object, e.g. {"ticket": …, "policy": …}.',
          doc: 'https://docs.typesafe.ai/concepts/state',
        }));
    }
    return out;
  }

  // -- broken path references ---------------------------------------------
  // A DOTTED path (`ticket.subject`) is unambiguously a state reference, so a
  // miss is an error. A BARE backticked word is not: TypeSafe's own docs
  // backtick option names ("add an `other` option"), and a Choice routinely
  // names its own options in the instructions. Treating those as paths made the
  // linter fail correct requests at error severity, so bare tokens are only
  // reported when they are not the question's own vocabulary, and only as info.
  for (const [id, q] of Object.entries(questions)) {
    const seen = new Set();
    const ownVocab = new Set(['true', 'false', 'null', 'yes', 'no']);
    if (q?.criteria && typeof q.criteria === 'object') {
      for (const k of Object.keys(q.criteria)) ownVocab.add(normalizeOption(k));
      for (const v of Object.values(q.criteria)) {
        if (typeof v === 'string') ownVocab.add(normalizeOption(v));
      }
    }
    for (const path of extractPaths(textOf(q?.instructions) + ' ' + textOf(q?.criteria))) {
      if (seen.has(path)) continue;
      seen.add(path);
      const bare = !/[.[]/.test(path);
      if (bare && ownVocab.has(normalizeOption(path))) continue; // it is an option name
      const { found, at } = resolvePath(state, path);
      if (found) continue;
      if (bare) {
        out.push(finding('state/unresolved-reference', 'info',
          `Question "${id}" backticks \`${path}\`, which is neither a state field nor one of its own options. If it was meant as a state reference it will not resolve.`, {
            questionId: id,
            fix: `Add ${path} to state, or drop the backticks if it is prose.`,
            doc: 'https://docs.typesafe.ai/concepts/state',
          }));
      } else {
        out.push(finding('state/broken-path', 'error',
          `Question "${id}" references \`${path}\`, but state has nothing at "${at}".`, {
            questionId: id,
            fix: `Add ${at} to state, or correct the path. jev reads instructions literally — it will not infer what you meant.`,
            doc: 'https://docs.typesafe.ai/concepts/state',
          }));
      }
    }
  }

  // -- unreferenced state: the context-rot signal --------------------------
  // jev-1.13 jaggedness §5: accuracy falls as state grows with content unrelated
  // to the decision. A top-level field no question mentions is the cheapest
  // available proxy for that.
  if (!Array.isArray(state)) {
    const keys = Object.keys(state);
    // The consistency cookbook adds a throwaway `uid` to every request as a cache
    // buster. It is meant to be unreferenced; telling users to delete it is wrong.
    const IMPLICIT = new Set(['uid', 'nonce', 'sample_uid']);
    const unref = keys.filter((k) => !IMPLICIT.has(k.toLowerCase()) && !new RegExp(`\\b${escapeRe(k)}\\b`, 'i').test(allText));
    if (unref.length && keys.length > 1) {
      out.push(finding('state/unreferenced-fields', 'info',
        `State fields never mentioned by any question: ${JSON.stringify(unref)}. Unrelated detail in state measurably costs accuracy.`, {
          fix: 'Filter state in code so you send only what the questions need, or reference the field explicitly.',
          doc: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
        }));
    }
  }

  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Lint a whole System One request: {state, model, questions}.
 * @returns {{findings: Array, counts: {error:number,warn:number,info:number}, ok: boolean}}
 */
export function lintRequest(req, opts = {}) {
  const out = [];

  if (!isPlainObject(req)) {
    return summarize([finding('request/not-an-object', 'error', 'Request must be a JSON object.')]);
  }
  if (req.state == null) {
    // [verified] live API 422 "Field required" for null as well as absent.
    out.push(finding('request/missing-state', 'error',
      `Request has ${req.state === null ? 'a null' : 'no'} "state".`, {
        doc: 'https://docs.typesafe.ai/concepts/state',
      }));
  } else if (typeof req.state !== 'string' && typeof req.state !== 'object') {
    // [verified] live API 422 string_type on a bare number/boolean.
    out.push(finding('state/wrong-type', 'error',
      `State is a ${typeof req.state}; it must be a string, object, or array of text.`, {
        doc: 'https://docs.typesafe.ai/concepts/state',
      }));
  }
  if (!req.model) {
    out.push(finding('request/missing-model', 'error', 'Request has no "model" (e.g. "jev-latest").', {
      doc: 'https://docs.typesafe.ai/models',
    }));
  }
  if (!isPlainObject(req.questions) || Object.keys(req.questions).length === 0) {
    out.push(finding('request/no-questions', 'error', 'Request has no questions.'));
    return summarize(out);
  }

  const entries = Object.entries(req.questions);
  if (entries.some(([id]) => id === '')) {
    // [verified] live API 400 "Question key cannot be empty."
    out.push(finding('question/empty-key', 'error', 'A question key is the empty string; the API rejects it.'));
  }
  for (const [id, q] of entries) out.push(...lintQuestion(id, q, opts));
  out.push(...lintState(req.state, req.questions, opts));

  // ---- context budget ---------------------------------------------------
  const stateTok = estimateTokens(req.state);
  const qToks = entries.map(([, q]) => estimateTokens(q));
  const totalTok = REQUEST_OVERHEAD_TOKENS + stateTok + qToks.reduce((a, b) => a + b, 0);
  const longestQ = qToks.length ? Math.max(...qToks) : 0;

  if (totalTok > CTX_TOTAL_TOKENS) {
    out.push(finding('context/over-total', 'error',
      `Estimated ${totalTok.toLocaleString()} tokens of state + questions exceeds the ${CTX_TOTAL_TOKENS.toLocaleString()} limit.`, {
        doc: 'https://docs.typesafe.ai/models',
      }));
  } else if (totalTok > CTX_TOTAL_TOKENS * 0.9) {
    out.push(finding('context/near-total', 'warn',
      `Estimated ${totalTok.toLocaleString()} tokens is within 10% of the ${CTX_TOTAL_TOKENS.toLocaleString()} limit.`));
  }
  if (stateTok + longestQ > CTX_STATE_PLUS_Q_TOKENS) {
    out.push(finding('context/over-state-plus-question', 'error',
      `Estimated state + longest question is ${(stateTok + longestQ).toLocaleString()} tokens, over the ${CTX_STATE_PLUS_Q_TOKENS.toLocaleString()} limit.`, {
        doc: 'https://docs.typesafe.ai/models',
      }));
  }

  // Cheap nudge toward the documented 12.2x cost win.
  if (entries.length === 1) {
    out.push(finding('request/single-question', 'info',
      'Only one question in this request. jev ingests state once and answers questions in parallel — batching independent questions into one call is documented at ~12x cheaper and ~10x faster.', {
        doc: 'https://docs.typesafe.ai/patterns/fan-out',
      }));
  }

  return summarize(applyOverrides(out, opts.rules));
}

/**
 * Apply user severity overrides. `rules` maps a rule id to
 * 'off' | 'info' | 'warn' | 'error'. Use this to silence a rule whose premise
 * does not hold for you — e.g. turn off choice/no-escape-hatch when your option
 * set really is exhaustive.
 */
export function applyOverrides(findings, rules) {
  if (!rules) return findings;
  const out = [];
  for (const f of findings) {
    const s = rules[f.rule];
    if (s === 'off') continue;
    out.push(s && s !== f.severity ? { ...f, severity: s } : f);
  }
  return out;
}

function summarize(findings) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return { findings, counts, ok: counts.error === 0 };
}
