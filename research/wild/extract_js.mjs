// Extract jev questions from JS/TS/TSX. Exact literals only; runtime values become
// {"__dynamic__": ...} so the linter never judges text we made up.
import { parse } from '@babel/parser';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(fileURLToPath(import.meta.url));
const HARVEST = join(ROOT, 'harvest');
const PRIMS = new Set(['noul', 'choice', 'score']);
const DYN = (why) => ({ __dynamic__: why });

function lit(n) {
  if (!n) return null;
  switch (n.type) {
    case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return n.value;
    case 'NullLiteral': return null;
    case 'TemplateLiteral': {
      let s = ''; n.quasis.forEach((q, i) => { s += q.value.cooked ?? ''; if (i < n.expressions.length) s += '{…}'; });
      return n.expressions.length ? { __template__: s } : s;
    }
    case 'ObjectExpression': {
      const o = {};
      for (const p of n.properties) {
        if (p.type !== 'ObjectProperty') { o.__spread__ = DYN(p.type); continue; }
        const k = p.key.type === 'Identifier' && !p.computed ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : '__dynkey__';
        o[k] = lit(p.value);
      }
      return o;
    }
    case 'ArrayExpression': return n.elements.map((e) => lit(e));
    case 'BinaryExpression': if (n.operator === '+') { const a = lit(n.left), b = lit(n.right); if (typeof a === 'string' && typeof b === 'string') return a + b; } break;
    case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': case 'ParenthesizedExpression': return lit(n.expression);
  }
  return DYN(n.type);
}
// Local names bound to TypeSafe's noul/choice/score, and namespaces imported whole.
// Plenty of repos define their own noul(id, category); only SDK imports count.
const SDK_MODULE = /typesafe/i;
function sdkBindings(program) {
  const names = new Map(), spaces = new Set();
  const bindPattern = (pat) => { for (const p of pat.properties) if (p.type === 'ObjectProperty' && PRIMS.has(p.key.name)) names.set(p.value.name ?? p.key.name, p.key.name); };
  for (const n of walk(program)) {
    if (n.type === 'ImportDeclaration' && SDK_MODULE.test(n.source.value)) {
      for (const s of n.specifiers) {
        if (s.type === 'ImportSpecifier' && PRIMS.has(s.imported.name ?? s.imported.value)) names.set(s.local.name, s.imported.name ?? s.imported.value);
        else if (s.type !== 'ImportSpecifier') spaces.add(s.local.name);
      }
    } else if (n.type === 'VariableDeclarator' && n.init?.type === 'CallExpression' && n.init.callee.name === 'require'
               && SDK_MODULE.test(n.init.arguments[0]?.value ?? '')) {
      if (n.id.type === 'ObjectPattern') bindPattern(n.id); else if (n.id.type === 'Identifier') spaces.add(n.id.name);
    }
  }
  return { names, spaces };
}
function sdkCall(c, { names, spaces }) {
  if (c?.type === 'Identifier') return names.get(c.name) ?? null;
  if (c?.type === 'MemberExpression' && !c.computed && PRIMS.has(c.property.name)) {
    let base = c.object; while (base?.type === 'MemberExpression') base = base.object;
    return base?.type === 'Identifier' && spaces.has(base.name) ? c.property.name : null;
  }
  return null;
}

function questionOf(n, bindings) {
  const prim = n?.type === 'CallExpression' ? sdkCall(n.callee, bindings) : null;
  if (prim && n.arguments.length) {
    const [instr, crit] = n.arguments;
    return { type: prim, instructions: lit(instr), ...(crit ? { criteria: lit(crit) } : {}) };
  }
  if (n?.type === 'ObjectExpression') {
    const o = lit(n);
    if (o && typeof o.type === 'string' && PRIMS.has(o.type) && ('instructions' in o || 'criteria' in o)) {
      return Object.fromEntries(['type', 'instructions', 'criteria'].filter((k) => k in o).map((k) => [k, o[k]]));
    }
  }
  return null;
}
function* walk(n) {
  if (!n || typeof n.type !== 'string') return;
  yield n;
  for (const k of Object.keys(n)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
    const v = n[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') yield* walk(x); }
    else if (v && typeof v.type === 'string') yield* walk(v);
  }
}
const files = [];
const scan = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? scan(p) : /\.(m|c)?[jt]sx?$/.test(f) && files.push(p); } };
scan(HARVEST);
const out = []; let parseFail = 0;
for (const p of files) {
  const rel = relative(HARVEST, p); const [repoDir, ...rest] = rel.split('/');
  const src = readFileSync(p, 'utf8');
  let ast;
  try { ast = parse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['typescript', 'jsx'] }); }
  catch { parseFail++; continue; }
  const seen = new Set(); const mentions = sdkBindings(ast.program);
  for (const n of walk(ast.program)) {          // questions keyed by id: { billing: noul(...) }
    if (n.type !== 'ObjectExpression') continue;
    for (const pr of n.properties) {
      if (pr.type !== 'ObjectProperty') continue;
      const q = questionOf(pr.value, mentions);
      if (!q) continue;
      seen.add(pr.value);
      const qid = pr.key.type === 'Identifier' ? pr.key.name : pr.key.type === 'StringLiteral' ? pr.key.value : null;
      out.push({ repo: repoDir.replace('__', '/'), file: rest.join('/'), lang: 'js', ...q, qid });
    }
  }
  for (const n of walk(ast.program)) {
    if (seen.has(n)) continue;
    const q = questionOf(n, mentions);
    if (q) out.push({ repo: repoDir.replace('__', '/'), file: rest.join('/'), lang: 'js', ...q, qid: null });
  }
}
writeFileSync(join(ROOT, 'questions_js.json'), JSON.stringify(out));
console.log(JSON.stringify({ questions: out.length, files: files.length, parseFail }));
