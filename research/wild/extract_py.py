"""Extract jev questions from Python, notebooks and JSON. Only exact literals are
kept; anything computed at runtime becomes a {"__dynamic__": ...} marker, so the
linter never judges text we invented."""
import ast, json, os, re, sys
ROOT = os.path.dirname(os.path.abspath(__file__))
HARVEST = os.path.join(ROOT, 'harvest')
PRIMS = {'noul', 'choice', 'score'}
is_prim = lambda v: isinstance(v, str) and v in PRIMS
CTORS = {'Noul': 'noul', 'Choice': 'choice', 'Score': 'score'}
DYN = lambda why: {'__dynamic__': why}

def lit(n):
    if isinstance(n, ast.Constant): return n.value
    if isinstance(n, ast.Dict):
        out = {}
        for k, v in zip(n.keys, n.values):
            if k is None: out['__spread__'] = DYN('**spread'); continue
            kk = lit(k)
            out[kk if isinstance(kk, (str, int, float, bool)) or kk is None else '__dynkey__'] = lit(v)
        return out
    if isinstance(n, (ast.List, ast.Tuple)): return [lit(e) for e in n.elts]
    if isinstance(n, ast.JoinedStr):   # f-string: keep the literal text, mark holes
        parts = [v.value if isinstance(v, ast.Constant) else '{…}' for v in n.values]
        s = ''.join(str(p) for p in parts)
        return s if '{…}' not in s else {'__template__': s}
    if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add):
        a, b = lit(n.left), lit(n.right)
        if isinstance(a, str) and isinstance(b, str): return a + b
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'strip' and not n.args:
        v = lit(n.func.value); return v.strip() if isinstance(v, str) else v
    return DYN(type(n).__name__)

def ctor_name(f):
    if isinstance(f, ast.Name): return f.id
    if isinstance(f, ast.Attribute): return f.attr
    return None

SDK_MODULE = re.compile(r'typesafe', re.I)

def sdk_bindings(tree):
    """Local names bound to TypeSafe's Noul/Choice/Score, and modules imported whole.
    Other libraries ship their own Choice with other signatures; only these count."""
    names, modules = {}, set()
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and SDK_MODULE.search(n.module or ''):
            for a in n.names:
                if a.name in CTORS: names[a.asname or a.name] = CTORS[a.name]
        elif isinstance(n, ast.Import):
            for a in n.names:
                if SDK_MODULE.search(a.name): modules.add(a.asname or a.name.split('.')[0])
    return names, modules

def sdk_ctor(f, bindings):
    names, modules = bindings
    if isinstance(f, ast.Name): return names.get(f.id)
    if isinstance(f, ast.Attribute) and f.attr in CTORS:
        base = f.value
        while isinstance(base, ast.Attribute): base = base.value
        if isinstance(base, ast.Name) and base.id in modules: return CTORS[f.attr]
    return None

def py_questions(src, bindings=None):
    try: tree = ast.parse(src)
    except SyntaxError: return None
    if bindings is None: bindings = sdk_bindings(tree)
    found, seen = [], set()
    def question_of(node):
        if isinstance(node, ast.Call) and sdk_ctor(node.func, bindings):
            kw = {k.arg: k.value for k in node.keywords if k.arg}
            args = list(node.args)
            instr = kw.get('instructions', args[0] if args else None)
            crit = kw.get('criteria', args[1] if len(args) > 1 else None)
            if instr is None and crit is None: return None
            return {'type': sdk_ctor(node.func, bindings),
                    **({'instructions': lit(instr)} if instr is not None else {}),
                    **({'criteria': lit(crit)} if crit is not None else {})}
        if isinstance(node, ast.Dict):
            d = lit(node)
            if isinstance(d, dict) and is_prim(d.get('type')) and ('instructions' in d or 'criteria' in d):
                return {k: d[k] for k in ('type', 'instructions', 'criteria') if k in d}
        return None
    for node in ast.walk(tree):            # questions keyed by id inside a dict
        if isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                q = question_of(v)
                if q:
                    seen.add(id(v)); kid = lit(k) if k is not None else None
                    found.append({**q, 'qid': kid if isinstance(kid, str) else None})
    for node in ast.walk(tree):            # standalone ones
        if id(node) in seen: continue
        q = question_of(node)
        if q: found.append({**q, 'qid': None})
    return found

def json_questions(obj):
    found = []
    def walk(v, key=None):
        if isinstance(v, dict):
            if is_prim(v.get('type')) and ('instructions' in v or 'criteria' in v):
                found.append({**{k: v[k] for k in ('type', 'instructions', 'criteria') if k in v}, 'qid': key}); return
            for k, x in v.items(): walk(x, k if isinstance(k, str) else None)
        elif isinstance(v, list):
            for x in v: walk(x, None)
    walk(obj); return found

out, stats = [], {'files': 0, 'parse_fail': 0, 'by_lang': {}}
for repo_dir in sorted(os.listdir(HARVEST)):
    repo = repo_dir.replace('__', '/', 1)
    for base, _, files in os.walk(os.path.join(HARVEST, repo_dir)):
        for f in files:
            p = os.path.join(base, f); rel = os.path.relpath(p, os.path.join(HARVEST, repo_dir))
            lang = 'python' if f.endswith('.py') else 'notebook' if f.endswith('.ipynb') else 'json' if f.endswith('.json') else None
            if not lang: continue
            stats['files'] += 1
            try: txt = open(p, encoding='utf-8', errors='replace').read()
            except OSError: continue
            qs = []
            if lang == 'python':
                r = py_questions(txt); qs = r or []
                if r is None: stats['parse_fail'] += 1
            elif lang == 'notebook':
                try:
                    nb = json.loads(txt)
                    cells = []
                    for cell in nb.get('cells', []):
                        if cell.get('cell_type') != 'code': continue
                        src = cell.get('source', []); code = src if isinstance(src, str) else ''.join(src)
                        cells.append('\n'.join(l for l in code.split('\n') if not l.lstrip().startswith(('%', '!'))))
                    names, modules = {}, set()   # imports usually live in an earlier cell
                    for code in cells:
                        try: b = sdk_bindings(ast.parse(code)); names.update(b[0]); modules |= b[1]
                        except SyntaxError: pass
                    for code in cells: qs += py_questions(code, (names, modules)) or []
                except json.JSONDecodeError: stats['parse_fail'] += 1
            else:
                try: qs = json_questions(json.loads(txt))
                except json.JSONDecodeError: stats['parse_fail'] += 1
            for q in qs: out.append({'repo': repo, 'file': rel, 'lang': lang, **q})
            stats['by_lang'][lang] = stats['by_lang'].get(lang, 0) + len(qs)
json.dump(out, open(os.path.join(ROOT, 'questions_py.json'), 'w'))
print(json.dumps({'questions': len(out), **stats}))
