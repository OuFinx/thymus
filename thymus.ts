import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Item = { id: string; label: string; path?: string; hash: string };
type Snap = Record<string, Record<string, Item>>;
type Change = { receptor: string; change: 'new' | 'changed' | 'removed'; item: Item };
type Card = { receptor?: string; id?: string; label?: string };

const run = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.THYMUS_HOME || join(homedir(), '.thymus');
const SELF = join(HOME, 'self.json');
const KNOWN = join(HOME, 'known.json');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Labels end up on screen and in self.json, so strip anything that looks like a secret.
const redact = (s: string) => s
  .replace(/((?:token|secret|password|passwd|apikey|api_key|auth)[\w-]*\s*[=:]\s*)\S+/gi, '$1***')
  .replace(/(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{32,}/g, '***')
  .slice(0, 160);

function receptors() {
  const found = new Map<string, string>();
  for (const dir of [join(ROOT, 'receptors'), join(HOME, 'receptors')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      const st = statSync(p);
      if (f.startsWith('.') || !st.isFile()) continue;
      if (extname(f) === '.ts' || st.mode & 0o111) found.set(basename(f, extname(f)), p);
    }
  }
  return found;
}

async function sense(file: string): Promise<Item[]> {
  const opts = { timeout: 30_000, maxBuffer: 64 << 20 };
  const loader = `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); process.stdout.write(JSON.stringify(await m.default()))`;
  const { stdout } = extname(file) === '.ts'
    ? await run(process.execPath, ['--no-warnings', '--input-type=module', '-e', loader], opts)
    : await run(file, [], opts);
  const items = JSON.parse(stdout);
  if (!Array.isArray(items) || !items.every((i) => i && typeof i.id === 'string' && typeof i.hash === 'string')) throw new Error('output is not a JSON array of {id, hash}');
  return items;
}

async function snapshot() {
  const snap: Snap = {};
  const errors: Record<string, string> = {};
  await Promise.all([...receptors()].map(async ([name, file]) => {
    try {
      const items: Snap[string] = {};
      for (const i of await sense(file)) {
        // Re-hash so a receptor that puts raw content in `hash` still never leaks it into self.json.
        items[i.id] = { id: i.id, label: redact(String(i.label ?? i.id)), ...(i.path ? { path: String(i.path) } : {}), hash: sha(i.hash) };
      }
      snap[name] = items;
    } catch (e: any) {
      errors[name] = String(e.killed ? 'timed out' : e.stderr?.trim().split('\n').pop() || e.message).slice(0, 200);
    }
  }));
  return { snap, errors };
}

const glob = (p = '*') => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
const readJson = (p: string, fallback: any) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;

function compare(base: Snap, cur: Snap, errors: Record<string, string>, known: Card[]) {
  const out: Change[] = [];
  const isKnown = (r: string, i: Item) => known.some((k) => glob(k.receptor).test(r) && glob(k.id).test(i.id) && glob(k.label).test(i.label));
  for (const r of new Set([...Object.keys(base), ...Object.keys(cur)])) {
    if (errors[r]) continue;
    const b = base[r] ?? {}, c = cur[r] ?? {};
    for (const [id, item] of Object.entries(c)) {
      if (b[id]?.hash === item.hash || isKnown(r, item)) continue;
      out.push({ receptor: r, change: b[id] ? 'changed' : 'new', item });
    }
    for (const [id, item] of Object.entries(b)) if (!c[id]) out.push({ receptor: r, change: 'removed', item });
  }
  return out;
}

function printErrors(errors: Record<string, string>) {
  for (const [r, e] of Object.entries(errors)) console.log(`  ! receptor ${r} failed: ${e}`);
}

const save = (snap: Snap, created?: string) => writeFileSync(SELF, JSON.stringify({ created: created ?? new Date().toISOString(), updated: new Date().toISOString(), receptors: snap }, null, 2) + '\n');
const sign = { new: '+', changed: '~', removed: '-' };

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'init') {
    if (existsSync(SELF) && !args.includes('--force')) return fail(`baseline already exists at ${SELF} (use --force to overwrite)`);
    mkdirSync(HOME, { recursive: true });
    if (!existsSync(KNOWN)) copyFileSync(join(ROOT, 'known.default.json'), KNOWN);
    const { snap, errors } = await snapshot();
    save(snap);
    const total = Object.values(snap).reduce((n, s) => n + Object.keys(s).length, 0);
    console.log(`thymus: learned ${total} items from ${Object.keys(snap).length} receptors into ${SELF}`);
    printErrors(errors);
    return 0;
  }
  if (cmd === 'diff' || cmd === 'approve') {
    if (!existsSync(SELF)) return fail(`no baseline at ${SELF}, run: thymus init`);
    const self = readJson(SELF, {});
    const { snap, errors } = await snapshot();
    const changes = compare(self.receptors, snap, errors, readJson(KNOWN, []));
    if (cmd === 'approve') return approve(self, changes, args);
    const alarming = changes.filter((c) => c.change !== 'removed');
    if (args.includes('--json')) {
      console.log(JSON.stringify({ changes: changes.map((c) => ({ receptor: c.receptor, change: c.change, ...c.item })), errors }, null, 2));
      return alarming.length ? 1 : 0;
    }
    const count = (k: string) => changes.filter((c) => c.change === k).length;
    console.log(`thymus: ${count('new')} new, ${count('changed')} changed, ${count('removed')} removed since ${new Date(self.updated).toLocaleString('sv').slice(0, 16)}`);
    let last = '';
    for (const c of [...changes].sort((a, b) => a.receptor.localeCompare(b.receptor))) {
      if (c.receptor !== last) console.log(`\n${last = c.receptor}`);
      console.log(`  ${sign[c.change]} ${c.receptor}:${c.item.id}  ${c.item.label === c.item.id ? '' : c.item.label}`.trimEnd());
      if (c.item.path) console.log(`      ${c.item.path}`);
    }
    if (Object.keys(errors).length) console.log('');
    printErrors(errors);
    if (alarming.length) {
      console.log('\nKnown and wanted?  thymus approve <receptor:id> ...   (or --all)');
      console.log('Not sure?  look at the file (cat, plutil -p), check where it came from (ls -l@ <path>; mdls -n kMDItemWhereFroms <path>), search the label online. Thymus never deletes anything: remove it by hand, then approve the removal.');
    }
    return alarming.length ? 1 : 0;
  }
  if (cmd === 'list') {
    const self = readJson(SELF, null);
    if (!self) return fail(`no baseline at ${SELF}, run: thymus init`);
    for (const [r, items] of Object.entries(self.receptors as Snap)) {
      console.log(`${r} (${Object.keys(items).length})`);
      for (const i of Object.values(items)) console.log(`  ${r}:${i.id}  ${i.label === i.id ? '' : i.label}`.trimEnd());
    }
    return 0;
  }
  if (cmd === 'receptors') {
    const { snap, errors } = await snapshot();
    for (const [name, file] of receptors()) console.log(`${name.padEnd(20)} ${errors[name] ? 'ERROR ' + errors[name] : String(Object.keys(snap[name]).length).padStart(5) + ' items'}  ${file}`);
    return 0;
  }
  console.log('usage: thymus init [--force] | diff [--json] | approve <receptor:id ...> | approve --all | list | receptors');
  return cmd ? 2 : 0;
}

function approve(self: { created: string; receptors: Snap }, changes: Change[], args: string[]) {
  const all = args.includes('--all');
  const picked = changes.filter((c) => all || args.includes(`${c.receptor}:${c.item.id}`) || args.includes(c.item.id));
  const missing = all ? [] : args.filter((a) => !picked.some((c) => a === `${c.receptor}:${c.item.id}` || a === c.item.id));
  for (const c of picked) {
    const r = (self.receptors[c.receptor] ??= {});
    if (c.change === 'removed') delete r[c.item.id];
    else r[c.item.id] = c.item;
  }
  save(self.receptors, self.created);
  console.log(`thymus: approved ${picked.length} change(s)`);
  for (const m of missing) console.log(`  ? no pending change matches ${m}`);
  return missing.length || (!all && !args.length) ? 1 : 0;
}

function fail(msg: string) {
  console.error(`thymus: ${msg}`);
  return 2;
}

process.exitCode = await main();
