#!/usr/bin/env node
/**
 * wellposed - lint TypeSafe System One (jev) requests before you send them.
 *
 *   wellposed lint <file.json|->   structural checks (free, offline)
 *   wellposed lint --semantic ...  + jev-on-jev checks (needs TYPESAFE_API_KEY)
 *   wellposed rules                list every rule
 *   wellposed eval                 score the linter against the labelled corpus
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintRequest, lintQuestion } from './structural.mjs';
import { semanticLint, CHECKS, LOW, HIGH } from './semantic.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ESC = String.fromCharCode(27);
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const blue = (s) => c('36', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const MARK = { error: red('error'), warn: yellow('warn '), info: blue('info ') };

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

function usage(code = 0) {
  console.log(`
${bold('wellposed')} - lint jev requests before you send them

  ${bold('wellposed lint')} <file.json|->    structural checks (free, offline, no API key)
      --semantic                  also run jev-on-jev semantic checks (needs TYPESAFE_API_KEY)
      --config <file>             JSON config: {"rules": {"<rule-id>": "off"|"info"|"warn"|"error"}}
      --json                      machine-readable output
      --quiet                     only errors
      --max-warnings <n>          exit non-zero if warnings exceed n

  ${bold('wellposed rules')}                 list every rule, its severity and its source
  ${bold('wellposed eval')}                  score the linter against the labelled corpus

Exit codes: 0 clean, 1 errors found (or warnings over --max-warnings), 2 bad usage.
`);
  process.exit(code);
}

function readInput(path) {
  if (!path || path === '-') return JSON.parse(readFileSync(0, 'utf8'));
  if (!existsSync(path)) {
    console.error(red(`no such file: ${path}`));
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function print(findings, { quiet }) {
  const shown = quiet ? findings.filter((f) => f.severity === 'error') : findings;
  if (!shown.length) {
    console.log(`\n  ${green('OK')} no findings\n`);
    return;
  }
  const byQ = new Map();
  for (const f of shown) {
    const k = f.questionId ?? '(request)';
    if (!byQ.has(k)) byQ.set(k, []);
    byQ.get(k).push(f);
  }
  console.log();
  for (const [q, fs] of byQ) {
    console.log(`  ${bold(q === '(request)' ? 'request' : `question "${q}"`)}`);
    for (const f of fs) {
      console.log(`    ${MARK[f.severity]}  ${f.message}`);
      if (f.fix) console.log(`           ${dim('fix: ' + f.fix)}`);
      console.log(`           ${dim(f.rule + (f.doc ? '  ' + f.doc : ''))}`);
    }
    console.log();
  }
}

const RULE_TABLE = [
  ['question/missing-instructions', 'error', 'verified: live API 400'],
  ['instructions/wrong-type', 'error', 'verified: live API 422'],
  ['noul/criteria-not-object', 'error', 'verified: live API 422'],
  ['question/invalid-type', 'error', 'docs: api reference'],
  ['choice/missing-criteria', 'error', 'docs: primitives/choice'],
  ['choice/too-many-options', 'error', 'docs: max 255 options'],
  ['choice/duplicate-options', 'error', 'degenerate'],
  ['score/too-few-levels', 'error', 'docs: primitives/score'],
  ['context/over-total', 'error', 'docs: 64k state+questions'],
  ['context/over-state-plus-question', 'error', 'docs: 32k state+longest question'],
  ['choice/no-escape-hatch', 'warn', 'measured: wrong answer at confidence 1.00'],
  ['noul/degree-question', 'warn', 'docs: use a Score for degree'],
  ['choice/degenerate', 'warn', 'answer is predetermined'],
  ['jev/counting', 'warn', 'jaggedness: jev does not count reliably'],
  ['jev/arithmetic', 'warn', 'jaggedness: keep math in code'],
  ['jev/date-comparison', 'warn', 'jaggedness: dates read as text'],
  ['jev/bundled-judgments', 'warn', 'jaggedness: one judgment per question'],
  ['jev/double-negative', 'warn', 'jaggedness: indirection costs accuracy'],
  ['noul/unexpected-criteria-keys', 'warn', 'only true/false are meaningful'],
  ['score/bare-levels', 'info', 'docs: levels should be concrete situations'],
  ['request/single-question', 'info', 'docs: batching is ~12x cheaper'],
];

async function main() {
  if (!cmd || flag('help') || cmd === 'help') usage(0);

  if (cmd === 'rules') {
    console.log(`\n  ${bold('structural')} ${dim('- free, offline, decided from the request JSON alone')}\n`);
    for (const [id, sev, note] of RULE_TABLE) {
      console.log(`    ${MARK[sev]}  ${id.padEnd(38)} ${dim(note)}`);
    }
    console.log(`\n  ${bold('semantic')} ${dim(`- one jev call per question; warn above ${HIGH}, uncertain ${LOW}-${HIGH}`)}\n`);
    for (const ch of CHECKS) {
      const note = ch.gatedOn ? `gated on ${ch.gatedOn}` : ch.applies.join('/');
      console.log(`    ${yellow('noul ')}  ${ch.id.padEnd(38)} ${dim(note)}`);
    }
    console.log();
    return;
  }

  if (cmd === 'eval') {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [join(ROOT, 'eval', 'agreement.mjs')], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  }

  if (cmd !== 'lint') usage(2);

  const positional = argv.slice(1).filter((a, i, arr) => {
    if (a.startsWith('--')) return false;
    const prev = arr[i - 1] ?? argv[argv.indexOf(a) - 1];
    return prev !== '--config' && prev !== '--max-warnings';
  });
  const req = readInput(positional[0]);
  const config = opt('config') ? JSON.parse(readFileSync(opt('config'), 'utf8')) : {};

  const structural = lintRequest(req, { rules: config.rules });
  const findings = [...structural.findings];
  let usageTotals = null;
  let calls = 0;

  if (flag('semantic')) {
    const byQ = new Map();
    for (const [id, q] of Object.entries(req.questions ?? {})) {
      const fired = lintQuestion(id, q, { rules: config.rules })
        .filter((f) => f.severity !== 'info')
        .map((f) => f.rule);
      byQ.set(id, new Set(fired));
    }
    try {
      const sem = await semanticLint(req, { structuralByQuestion: byQ, rules: config.rules });
      findings.push(...sem.findings);
      usageTotals = sem.usage;
      calls = sem.calls;
    } catch (e) {
      if (e.code === 'NO_API_KEY') {
        console.error(`\n  ${yellow('skipped semantic checks')}: ${e.message}\n`);
      } else {
        throw e;
      }
    }
  }

  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  if (flag('json')) {
    console.log(JSON.stringify(
      { ok: counts.error === 0, counts, findings, semantic: { calls, usage: usageTotals } },
      null, 2));
  } else {
    print(findings, { quiet: flag('quiet') });
    const parts = [`${counts.error} error`, `${counts.warn} warn`, `${counts.info} info`];
    const tail = calls
      ? dim(`  ·  ${calls} jev call${calls > 1 ? 's' : ''}, ${usageTotals.input_tokens} in / ${usageTotals.output_tokens} out`)
      : '';
    console.log(`  ${dim(parts.join('  ·  '))}${tail}\n`);
  }

  const maxW = opt('max-warnings');
  if (counts.error > 0) process.exit(1);
  if (maxW != null && counts.warn > Number(maxW)) process.exit(1);
}

main().catch((e) => {
  console.error(red(`\n  ${e.message}\n`));
  process.exit(1);
});
