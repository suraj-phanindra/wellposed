#!/usr/bin/env node
/**
 * wellposed - lint TypeSafe System One (jev) requests before you send them.
 *
 *   wellposed lint <file.json|->   structural checks (free, offline)
 *   wellposed lint --semantic ...  + jev-on-jev checks (needs TYPESAFE_API_KEY)
 *   wellposed rules                list every rule
 *   wellposed eval                 score the linter against the labelled corpus
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintRequest, lintQuestion, RULES } from './structural.mjs';
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
const flag = (n) => argv.includes(`--${n}`) || argv.some((a) => a === `--${n}=true`);
const opt = (n, d) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const KNOWN_FLAGS = ['semantic', 'config', 'json', 'quiet', 'max-warnings', 'help'];
const VALUE_FLAGS = ['config', 'max-warnings'];
function requireFlagValues() {
  for (const n of VALUE_FLAGS) {
    const i = argv.indexOf(`--${n}`);
    if (i >= 0 && (i === argv.length - 1 || String(argv[i + 1]).startsWith('--'))) {
      console.error(red(`--${n} needs a value`));
      process.exit(2);
    }
  }
}
function rejectUnknownFlags() {
  const bad = argv.filter((a) => a.startsWith('--'))
    .map((a) => a.replace(/^--/, '').split('=')[0])
    .filter((n) => !KNOWN_FLAGS.includes(n));
  if (bad.length) {
    console.error(red(`unknown flag${bad.length > 1 ? 's' : ''}: ${bad.map((b) => '--' + b).join(', ')}`));
    console.error(dim(`known flags: ${KNOWN_FLAGS.map((f) => '--' + f).join(', ')}`));
    process.exit(2);
  }
}

function usage(code = 0, msg) {
  const out = code === 0 ? console.log : console.error;
  if (msg) out(red(msg));
  out(`
${bold('wellposed')} - lint jev requests before you send them

  ${bold('wellposed lint')} <file.json ...|->  structural checks (free, offline, no API key)
      -                           read the request from stdin
      --semantic                  also run jev-on-jev semantic checks (needs TYPESAFE_API_KEY)
      --config <file>             JSON config: {"rules": {"<rule-id>": "off"|"info"|"warn"|"error"}}
      --json                      machine-readable output
      --quiet                     only errors (text output; --json is unaffected)
      --max-warnings <n>          exit non-zero if warnings exceed n

  ${bold('wellposed rules')}                 list every rule, its severity and its source
  ${bold('wellposed eval')}                  score the linter against the labelled corpus

Exit codes: 0 clean, 1 errors found (or warnings over --max-warnings), 2 bad usage.
`);
  process.exit(code);
}

const stripBom = (s) => s.replace(/^\uFEFF/, '');

function parseJson(raw, label) {
  try {
    return JSON.parse(stripBom(raw));
  } catch (e) {
    console.error(red(`${label} is not valid JSON: ${e.message}`));
    process.exit(2);
  }
}

function readInput(path) {
  if (path === '-') return parseJson(readFileSync(0, 'utf8'), 'stdin');
  if (!path) {
    // Reading fd 0 with no redirect blocks forever on a tty, which looked like
    // a hang. Require an explicit "-" for stdin.
    console.error(red('lint needs a file argument, or "-" to read stdin'));
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(red(`no such file: ${path}`));
    process.exit(2);
  }
  try {
    if (statSync(path).isDirectory()) {
      console.error(red(`${path} is a directory, not a request file`));
      process.exit(2);
    }
  } catch { /* fall through to the read */ }
  return parseJson(readFileSync(path, 'utf8'), path);
}

function print(findings, { quiet }) {
  const shown = quiet ? findings.filter((f) => f.severity === 'error') : findings;
  if (!shown.length) {
    const hidden = findings.length - shown.length;
    console.log(hidden
      ? `\n  ${green('OK')} no errors ${dim(`(${hidden} warning/info finding${hidden > 1 ? 's' : ''} hidden by --quiet)`)}\n`
      : `\n  ${green('OK')} no findings\n`);
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


async function main() {
  if (!cmd || flag('help') || cmd === 'help') usage(0);

  if (cmd === 'rules') {
    console.log(`\n  ${bold('structural')} ${dim('- free, offline, decided from the request JSON alone')}\n`);
    const order = { error: 0, warn: 1, info: 2 };
    const ids = Object.keys(RULES).sort((a, b) =>
      (order[RULES[a].severity] - order[RULES[b].severity]) || a.localeCompare(b));
    for (const id of ids) {
      console.log(`    ${MARK[RULES[id].severity]}  ${id.padEnd(38)} ${dim(RULES[id].source)}`);
    }
    console.log(`\n    ${dim(`${ids.length} structural rules`)}`);
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

  if (cmd !== 'lint') usage(2, `unknown command: ${cmd}`);
  rejectUnknownFlags();
  requireFlagValues();

  const positional = argv.slice(1).filter((a, i, arr) => {
    if (a.startsWith('--')) return false;
    const prev = arr[i - 1] ?? argv[argv.indexOf(a) - 1];
    return prev !== '--config' && prev !== '--max-warnings';
  });
  if (positional.length === 0) readInput(undefined); // exits 2 with a usage message
  if (positional.filter((x) => x === '-').length > 1) {
    console.error(red('stdin ("-") can only be read once'));
    process.exit(2);
  }

  const maxW = opt('max-warnings');
  if (maxW != null && !Number.isFinite(Number(maxW))) {
    console.error(red(`--max-warnings expects a number, got "${maxW}"`));
    process.exit(2);
  }

  const cfgPath = opt('config');
  if (cfgPath && !existsSync(cfgPath)) {
    console.error(red(`no such config file: ${cfgPath}`));
    process.exit(2);
  }
  const config = cfgPath ? parseJson(readFileSync(cfgPath, 'utf8'), cfgPath) : {};
  const VALID_SEV = ['off', 'info', 'warn', 'error'];
  for (const [rule, sev] of Object.entries(config.rules ?? {})) {
    if (!VALID_SEV.includes(sev)) {
      console.error(red(`config: rule "${rule}" has severity "${sev}"; must be one of ${VALID_SEV.join(', ')}`));
      process.exit(2);
    }
    // RULES holds the structural ids; the semantic ones live in CHECKS. Both
    // are listed by `wellposed rules`, so both must be configurable.
    if (!(rule in RULES) && !CHECKS.some((c) => c.id === rule)) {
      console.error(red(`config: unknown rule "${rule}". Run \`wellposed rules\` for the list.`));
      process.exit(2);
    }
  }

  if (config.forbidden != null && !(Array.isArray(config.forbidden)
      && config.forbidden.every((f) => typeof f === 'string' && f.trim()))) {
    console.error(red('config: "forbidden" must be an array of non-empty field names or dotted paths'));
    process.exit(2);
  }

  // Read every input before reporting anything, so a missing or malformed file
  // is a usage error for the whole run. This used to lint positional[0] only and
  // exit on it — `wellposed lint *.json` in CI linted one file of thirty and went
  // green, the worst thing a linter can do.
  const inputs = positional.map((x) => ({ file: x === '-' ? '(stdin)' : x, req: readInput(x) }));
  const multi = inputs.length > 1;

  const results = [];
  for (const { file, req } of inputs) {
    results.push(await lintOne(req, config, multi ? file : null));
  }

  const total = { error: 0, warn: 0, info: 0 };
  const semTotal = { calls: 0, usage: { input_tokens: 0, output_tokens: 0 } };
  for (const r of results) {
    for (const k of Object.keys(total)) total[k] += r.counts[k];
    semTotal.calls += r.semantic.calls;
    semTotal.usage.input_tokens += r.semantic.usage?.input_tokens ?? 0;
    semTotal.usage.output_tokens += r.semantic.usage?.output_tokens ?? 0;
  }

  if (flag('json')) {
    // One file keeps the original shape, so existing consumers do not break.
    // Several files add a `files` array and aggregate `ok` / `counts`.
    const out = multi
      ? { ok: total.error === 0, counts: total,
          files: results.map((r, i) => ({ file: inputs[i].file, ok: r.counts.error === 0, ...r })) }
      : { ok: total.error === 0, counts: total, findings: results[0].findings, semantic: results[0].semantic };
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const [i, r] of results.entries()) {
      if (multi) console.log(`\n${bold(inputs[i].file)}`);
      print(r.findings, { quiet: flag('quiet') });
      console.log(`  ${dim(summaryLine(r.counts, r.semantic))}\n`);
    }
    if (multi) {
      const failed = results.filter((r) => r.counts.error > 0).length;
      console.log(`${bold('total')}  ${dim(`${inputs.length} files, ${failed} with errors  ·  ${summaryLine(total, semTotal)}`)}\n`);
    }
  }

  if (total.error > 0) process.exit(1);
  if (maxW != null && total.warn > Number(maxW)) process.exit(1);
}

function summaryLine(counts, sem) {
  const parts = [`${counts.error} error`, `${counts.warn} warn`, `${counts.info} info`].join('  ·  ');
  const tail = sem?.calls
    ? `  ·  ${sem.calls} jev call${sem.calls > 1 ? 's' : ''}, ${sem.usage.input_tokens} in / ${sem.usage.output_tokens} out`
    : '';
  return parts + tail;
}

/** Structural pass, plus the semantic pass when asked. Never throws on a semantic failure. */
async function lintOne(req, config, label) {
  const findings = [...lintRequest(req, { rules: config.rules, forbidden: config.forbidden }).findings];
  const semantic = { requested: flag('semantic'), skipped: null, calls: 0, usage: null };

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
      semantic.calls = sem.calls;
      semantic.usage = sem.usage;
    } catch (e) {
      // The structural pass is free, offline and already complete. Throwing
      // here used to discard it entirely and emit zero bytes under --json,
      // indistinguishable from "errors found".
      semantic.skipped = e.code === 'NO_API_KEY' ? 'no API key'
        : e.name === 'TimeoutError' ? 'request timed out'
        : e.message;
      if (!flag('json')) {
        console.error(`\n  ${yellow('semantic checks skipped')}${label ? ` for ${label}` : ''}: ${semantic.skipped}`);
        console.error(`  ${dim('the structural report is complete and unaffected')}`);
      }
    }
  }

  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { counts, findings, semantic };
}

main().catch((e) => {
  console.error(red(`\n  ${e.message}\n`));
  process.exit(1);
});
