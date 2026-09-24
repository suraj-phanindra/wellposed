"""Fetch only source files that could contain jev questions, from every repo.
Partial clone (blob:none) + sparse checkout of source extensions, so a repo that is
large because of binaries costs only its source. Candidate files are copied out and
the clone is deleted immediately, keeping disk use small."""
import json, os, re, shutil, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'harvest'); os.makedirs(OUT, exist_ok=True)
EXT = ('.py', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.ipynb')
SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', 'vendor', '.next', 'venv', '.venv', '__pycache__', 'site-packages', 'coverage', '.turbo'}
CAND = re.compile(r'typesafe|system_?one|\bnoul\b|jev-(?:latest|preview|1\.)|["\']?type["\']?\s*:\s*["\'](?:choice|score|noul)["\']', re.I)
SPARSE = ['/*'] + [f'**/*{e}' for e in EXT] + [f'!**/{d}/' for d in SKIP_DIRS]

def run(cmd, cwd=None, t=180):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=t)

def harvest(r):
    repo = r['repo']; rec = {'repo': repo, 'ok': False, 'candidates': 0, 'files_scanned': 0}
    tmp = tempfile.mkdtemp(prefix='hv-')
    try:
        d = os.path.join(tmp, 'r')
        run(['git', 'clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', f'https://github.com/{repo}.git', d])
        run(['git', 'sparse-checkout', 'set', '--no-cone', *SPARSE], cwd=d)
        c = run(['git', 'checkout', '-q'], cwd=d, t=240)
        if c.returncode != 0 and not os.listdir(d):
            rec['error'] = c.stderr.strip()[:160]; return rec
        dest = os.path.join(OUT, repo.replace('/', '__'))
        for base, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            for f in files:
                if not f.endswith(EXT) or f in ('package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'): continue
                p = os.path.join(base, f)
                try:
                    if os.path.getsize(p) > 2_000_000: continue
                    rec['files_scanned'] += 1
                    txt = open(p, encoding='utf-8', errors='replace').read()
                except OSError:
                    continue
                if CAND.search(txt):
                    rel = os.path.relpath(p, d); tgt = os.path.join(dest, rel)
                    os.makedirs(os.path.dirname(tgt), exist_ok=True); shutil.copyfile(p, tgt)
                    rec['candidates'] += 1
        rec['ok'] = True
    except subprocess.TimeoutExpired:
        rec['error'] = 'timeout'
    except Exception as e:
        rec['error'] = f'{type(e).__name__}: {e}'[:160]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return rec

repos = [r for r in json.load(open(os.path.join(ROOT, 'repos.json'))) if r.get('exists')]
done = set()
logp = os.path.join(ROOT, 'harvest-log.jsonl')
if os.path.exists(logp):
    done = {json.loads(l)['repo'] for l in open(logp)}
todo = [r for r in repos if r['repo'] not in done]
print(f'{len(todo)} to harvest ({len(done)} already done)', flush=True)
with open(logp, 'a') as log, ThreadPoolExecutor(8) as ex:
    futs = [ex.submit(harvest, r) for r in todo]
    for n, f in enumerate(as_completed(futs), 1):
        log.write(json.dumps(f.result()) + '\n'); log.flush()
        if n % 100 == 0: print(f'  {n}/{len(todo)}', flush=True)
print('done', flush=True)
