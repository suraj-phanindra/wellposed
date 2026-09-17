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

// Docs (jev-1.13 jaggedness): 64k tokens for all state + questions together;
// 32k for state + the longest single question.
export const CTX_TOTAL_TOKENS = 64_000;
export const CTX_STATE_PLUS_Q_TOKENS = 32_000;

/** Rough token estimate. Deliberately crude — we only use it near the limit. */
export const estimateTokens = (s) => Math.ceil(JSON.stringify(s ?? '').length / 4);

const ESCAPE_HATCH = /^(other|others|none|none of the above|n\/?a|unknown|not stated|not specified|no match|neither|unclear|cannot tell|can't tell|undetermined|uncertain)$/i;
const ESCAPE_HATCH_DESC = /\b(none of (the )?(above|these)|fits none|no(ne)? of the (other|listed)|does not fit|doesn'?t fit|not covered)\b/i;

// jev-1.13 jaggedness §2 "Math and Numbers" — it does not count reliably.
const RE_COUNTING = /\b(how many|number of|count (?:the|how)|tally|occurrences? of|total number)\b/i;
// jev-1.13 jaggedness §2 — arithmetic belongs in code.
const RE_ARITHMETIC = /\b(calculate|compute|sum of|average|mean of|percentage|divide|multiply|subtract|add up|ratio of)\b/i;
// jev-1.13 jaggedness §3 — dates are read as text, not ordered quantities.
const RE_DATE_COMPARE = /\b(before|after|earlier than|later than|more recent|older than|within (the )?(last|next|past)|between .{0,20}\band\b.{0,20}(date|day|week|month|year)|how long ago|days? (ago|apart|between))\b/i;
// Docs: a Noul is yes/no. A question about degree belongs in a Score.
const RE_DEGREE = /\b(how (much|urgent|severe|likely|well|strong|good|bad|relevant|confident|important|risky|complex)|on a scale|rate (the|this|how)|what (degree|level|extent)|to what extent|score (the|this)|how many years)\b/i;
// jev-1.13: "Hiding several judgments inside one question."
const RE_BUNDLED = /\b(\w+)\s+and\s+(?:also\s+)?(?:is|are|does|do|did|has|have|was|were|can|should|will)\b|,\s*and\s+(?:is|are|does|do|did|has|have|whether)\b/i;
// jev-1.13 §4 Indirection — double negatives cost accuracy.
const RE_DOUBLE_NEG = /\bnot\b[^.?!]{0,40}\b(un|in|non|dis)\w+|\bnever\b[^.?!]{0,40}\bnot\b|\bnot\b[^.?!]{0,40}\bwithout\b/i;

/** Flatten instructions (string | object | array) into searchable text. */
export function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).join(' ');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k} ${textOf(x)}`).join(' ');
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
  const hasCriteria = q.criteria != null;

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
    if (RE_DEGREE.test(text)) {
      out.push(finding('noul/degree-question', 'warn',
        `Noul "${id}" asks about degree ("${firstMatch(RE_DEGREE, text)}"), but a Noul returns only P(yes).`, {
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
    } else if (!isPlainObject(q.criteria) && !Array.isArray(q.criteria)) {
      out.push(finding('choice/criteria-wrong-type', 'error',
        `Choice "${id}" criteria must be an object mapping option -> description (or an array of option names).`, at));
    } else {
      const opts = Array.isArray(q.criteria) ? q.criteria.map(String) : Object.keys(q.criteria);

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
      const dupes = opts.filter((o, i) => opts.findIndex((p) => p.toLowerCase() === o.toLowerCase()) !== i);
      if (dupes.length) {
        out.push(finding('choice/duplicate-options', 'error',
          `Choice "${id}" has duplicate options: ${JSON.stringify([...new Set(dupes)])}.`, at));
      }

      // The headline rule. Measured: 0 of 11 generated Choices had one, and a
      // Choice without one answered a not-covered input at confidence 1.00.
      const descs = Array.isArray(q.criteria) ? [] : Object.values(q.criteria).map(textOf);
      const hasHatch = opts.some((o) => ESCAPE_HATCH.test(String(o).trim()))
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
      const levels = Array.isArray(q.criteria) ? q.criteria.map(textOf)
        : isPlainObject(q.criteria) ? Object.values(q.criteria).map(textOf)
        : null;
      if (levels == null) {
        out.push(finding('score/criteria-wrong-type', 'error',
          `Score "${id}" criteria must be an ordered array of levels (or an object of them).`, at));
      } else {
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
  for (const [re, rule, msg, fix] of [
    [RE_COUNTING, 'jev/counting', 'asks jev to count', 'Count in code: ask one question per item and sum the answers yourself.'],
    [RE_ARITHMETIC, 'jev/arithmetic', 'asks jev to do arithmetic', 'Keep the arithmetic in code; give jev the judgment only.'],
    [RE_DATE_COMPARE, 'jev/date-comparison', 'asks jev to compare or order dates', 'Extract date parts with a Choice (include "not stated"), then compare in code.'],
    [RE_BUNDLED, 'jev/bundled-judgments', 'appears to bundle several judgments into one question', 'Split into separate questions and combine them in code — they run in parallel at no extra round trip.'],
    [RE_DOUBLE_NEG, 'jev/double-negative', 'contains a double negative or indirection', 'Rewrite as a direct positive condition.'],
  ]) {
    if (re.test(text)) {
      // For phrase-triggered rules the matched words are the useful evidence;
      // for structural patterns they read as nonsense, so show the instruction.
      const quote = ['jev/bundled-judgments', 'jev/double-negative'].includes(rule)
        ? `"${text.trim().slice(0, 80)}${text.trim().length > 80 ? '…' : ''}"`
        : `"${firstMatch(re, text)}"`;
      out.push(finding(rule, 'warn', `Question "${id}" ${msg}: ${quote}. jev-1.13 is documented to be unreliable here.`, {
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
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = root;
  const walked = [];
  for (const part of parts) {
    walked.push(part);
    if (cur == null || typeof cur !== 'object') return { found: false, at: walked.join('.') };
    const key = Array.isArray(cur) ? Number(part) : part;
    if (!(key in cur)) return { found: false, at: walked.join('.') };
    cur = cur[key];
  }
  return { found: true, at: path };
}

/**
 * Checks that need state and questions together.
 * Only runs when state is a JSON object/array — a plain-string state has no
 * named fields, so nothing here applies.
 */
export function lintState(state, questions) {
  const out = [];
  if (state == null) return out;

  const isStructured = typeof state === 'object';
  const allText = Object.values(questions).map((q) => textOf(q?.instructions) + ' ' + textOf(q?.criteria)).join(' \n ');

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

  // -- broken path references: fully deterministic -------------------------
  for (const [id, q] of Object.entries(questions)) {
    const seen = new Set();
    for (const path of extractPaths(textOf(q?.instructions) + ' ' + textOf(q?.criteria))) {
      if (seen.has(path)) continue;
      seen.add(path);
      const { found, at } = resolvePath(state, path);
      if (!found) {
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
    const unref = keys.filter((k) => !new RegExp(`\\b${escapeRe(k)}\\b`, 'i').test(allText));
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
  if (req.state === undefined) {
    out.push(finding('request/missing-state', 'error', 'Request has no "state".', {
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
  for (const [id, q] of entries) out.push(...lintQuestion(id, q, opts));
  out.push(...lintState(req.state, req.questions));

  // ---- context budget ---------------------------------------------------
  const stateTok = estimateTokens(req.state);
  const qToks = entries.map(([, q]) => estimateTokens(q));
  const totalTok = stateTok + qToks.reduce((a, b) => a + b, 0);
  const longestQ = qToks.length ? Math.max(...qToks) : 0;

  if (totalTok > CTX_TOTAL_TOKENS) {
    out.push(finding('context/over-total', 'error',
      `Estimated ${totalTok.toLocaleString()} tokens of state + questions exceeds the ${CTX_TOTAL_TOKENS.toLocaleString()} limit.`, {
        doc: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
      }));
  } else if (totalTok > CTX_TOTAL_TOKENS * 0.9) {
    out.push(finding('context/near-total', 'warn',
      `Estimated ${totalTok.toLocaleString()} tokens is within 10% of the ${CTX_TOTAL_TOKENS.toLocaleString()} limit.`));
  }
  if (stateTok + longestQ > CTX_STATE_PLUS_Q_TOKENS) {
    out.push(finding('context/over-state-plus-question', 'error',
      `Estimated state + longest question is ${(stateTok + longestQ).toLocaleString()} tokens, over the ${CTX_STATE_PLUS_Q_TOKENS.toLocaleString()} limit.`, {
        doc: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
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
