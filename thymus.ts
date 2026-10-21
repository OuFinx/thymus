import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCKFILES, globalNpm, lockfile, malicious, type Pkg } from './check.ts';
import { roots, walk } from './receptors/projects.ts';

type Signer = { kind: string; path: string; team?: string; org?: string };
type Item = { id: string; label: string; path?: string; hash: string; signer?: Signer };
type Snap = Record<string, Record<string, Item>>;
type Change = { receptor: string; change: 'new' | 'changed' | 'removed'; item: Item };
type Card = { receptor?: string; id?: string; label?: string; team?: string };
type Ioc = { file?: string; sha256?: string; label?: string; note?: string; url?: string; pack: string; advice?: string };
type Hit = { receptor: string; item: Item; ioc: Ioc };

const run = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.THYMUS_HOME || join(homedir(), '.thymus');
const SELF = join(HOME, 'self.json');
const KNOWN = join(HOME, 'known.json');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

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

async function sense(file: string): Promise<any[]> {
  const opts = { timeout: 30_000, maxBuffer: 64 << 20 };
  const loader = `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); process.stdout.write(JSON.stringify(await m.default()))`;
  const { stdout } = extname(file) === '.ts'
    ? await run(process.execPath, ['--no-warnings', '--input-type=module', '-e', loader], opts)
    : await run(file, [], opts);
  const items = JSON.parse(stdout);
  if (!Array.isArray(items) || !items.every((i) => i && typeof i.id === 'string' && typeof i.hash === 'string')) throw new Error('output is not a JSON array of {id, hash}');
  return items;
}

// Code signing of what an item runs. Receptors give `exec` (argv); only the verdict is kept, never the argv, and it is not part of the hash.
const INTERP = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl|php|osascript|(ba|z|da|k|c|tc|fi)?sh)$/;
const RUNNER = /^(npx|bunx|pnpx|uvx|pipx)$/;
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const untilde = (p: string) => p.replace(/^~(?=\/)/, homedir());
const which = (cmd: string) => cmd.includes('/') ? cmd : [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'].map((d) => join(d, cmd)).find(isFile) ?? cmd;
function shebang(p: string) {
  try { const fd = openSync(p, 'r'), b = Buffer.alloc(2); readSync(fd, b, 0, 2, 0); closeSync(fd); return b.toString() === '#!'; } catch { return false; }
}

async function trust(argv: string[], base: string | undefined, cache: Record<string, { m: number; s: Signer }>): Promise<Signer | undefined> {
  let [cmd, ...args] = argv.map(String);
  if (cmd && basename(cmd) === 'env') { while (args[0]?.startsWith('-') || args[0]?.includes('=')) args.shift(); cmd = args.shift()!; }
  if (!cmd) return;
  if (RUNNER.test(basename(cmd))) return { kind: 'runner', path: cmd };
  if (cmd === '/usr/bin/open' || cmd === 'open') { const app = args.find((a) => !a.startsWith('-')); if (app) return trust([app], base, cache); }
  if (INTERP.test(basename(cmd))) {
    const target = args.find((a) => !a.startsWith('-'));
    const file = target && resolve(base ? dirname(base) : '/', untilde(target));
    if (file && isFile(file)) return { kind: 'script', path: file };
  }
  const exe = which(untilde(cmd));
  if (!existsSync(exe)) return { kind: 'missing', path: exe };
  if (shebang(exe)) return { kind: 'script', path: exe };
  // ponytail: keyed by path + mtime of the file or bundle dir; an in-place edit deep inside a bundle keeps the old verdict until the top dir changes.
  const m = statSync(exe).mtimeMs;
  if (cache[exe]?.m === m) return cache[exe].s;
  const { stderr } = await run('codesign', ['-dv', '--verbose=2', exe]).catch((e) => e);
  const out = String(stderr ?? ''), dev = out.match(/^Authority=Developer ID Application: (.+) \((\w+)\)$/m), team = out.match(/^TeamIdentifier=(?!not set)(\S+)/m)?.[1];
  const kind = /not signed at all/.test(out) ? 'unsigned' : /^Signature=adhoc/m.test(out) ? 'ad-hoc' : dev ? 'developer-id'
    : /^Authority=Apple Mac OS Application Signing/m.test(out) ? 'app-store' : /^Platform identifier=|^Authority=(macOS )?Software Signing$/m.test(out) ? 'apple' : team ? 'other' : 'unknown';
  const s: Signer = { kind, path: exe, ...(team ? { team } : {}), ...(dev ? { org: dev[1] } : {}) };
  cache[exe] = { m, s };
  return s;
}

const userDir = (p: string) => [homedir() + '/', '/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/', '/Users/Shared/'].some((d) => p.startsWith(d));
const risky = (s?: Signer) => !!s && (['unsigned', 'ad-hoc', 'missing'].includes(s.kind) || (s.kind === 'script' && userDir(s.path)));
const signText = (s: Signer) => ({
  apple: 'Apple', 'app-store': `App Store ${s.team}`, 'developer-id': `Developer ID ${s.team}`, other: `signed ${s.team}`, 'ad-hoc': 'ad-hoc signed', unsigned: 'unsigned',
  missing: 'binary missing', script: risky(s) ? 'script in a writable folder' : 'script', runner: 'downloads a package at run time', unknown: 'signature unknown',
} as Record<string, string>)[s.kind] ?? s.kind;

async function snapshot() {
  const snap: Snap = {};
  const errors: Record<string, string> = {};
  const cacheFile = join(HOME, 'codesign-cache.json'), cache = readJson(cacheFile, {}), signing: Promise<void>[] = [];
  await Promise.all([...receptors()].map(async ([name, file]) => {
    try {
      const items: Snap[string] = {};
      for (const i of await sense(file)) {
        // Re-hash so a receptor that puts raw content in `hash` still never leaks it into self.json.
        const item: Item = items[i.id] = { id: i.id, label: redact(String(i.label ?? i.id)), ...(i.path ? { path: String(i.path) } : {}), hash: sha(i.hash) };
        if (Array.isArray(i.exec)) signing.push(trust(i.exec, item.path, cache).then((s) => { if (s) item.signer = s; }, () => {}));
      }
      snap[name] = items;
    } catch (e: any) {
      errors[name] = String(e.killed ? 'timed out' : e.stderr?.trim().split('\n').pop() || e.message).slice(0, 200);
    }
  }));
  await Promise.all(signing);
  if (existsSync(HOME)) writeFileSync(cacheFile, JSON.stringify(cache));
  return { snap, errors };
}

const globs = new Map<string, RegExp>();
const glob = (p = '*') => globs.get(p) ?? globs.set(p, new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')).get(p)!;
const readJson = (p: string, fallback: any) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
const known = (cards: Card[]) => (r: string, i: Item) => cards.some((k) => glob(k.receptor).test(r) && glob(k.id).test(i.id) && glob(k.label).test(i.label) && (!k.team || glob(k.team).test(i.signer?.team ?? '')));

function compare(base: Snap, cur: Snap, errors: Record<string, string>, cards: Card[]) {
  const out: Change[] = [];
  const isKnown = known(cards);
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

// Antibody packs: built-in antibodies/*.json plus ~/.thymus/antibodies/*.json.
function antibodies(): Ioc[] {
  const out: Ioc[] = [];
  for (const dir of [join(ROOT, 'antibodies'), join(HOME, 'antibodies')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      try {
        const pack = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        for (const i of pack.iocs ?? []) out.push({ ...i, pack: pack.name ?? basename(f, '.json'), ...(pack.advice ? { advice: pack.advice } : {}) });
      } catch (e: any) { console.error(`thymus: antibody pack ${f} skipped: ${e.message}`); }
    }
  }
  return out;
}

const shas = new Map<string, string | null>();
function fileSha(p: string) {
  if (!shas.has(p)) { let h = null; try { if (statSync(p).size < 64 << 20) h = sha(readFileSync(p)); } catch {} shas.set(p, h); }
  return shas.get(p);
}

// A `file` IOC with a slash is a glob on the full path, otherwise on the file name.
const fileMatch = (ioc: Ioc, p: string) => !!ioc.file && glob(ioc.file).test(ioc.file.includes('/') ? p : basename(p));

function infected(snap: Snap, iocs: Ioc[]): Hit[] {
  const hits: Hit[] = [];
  for (const [r, items] of Object.entries(snap)) for (const item of Object.values(items)) {
    const paths = [item.path, item.signer?.path].filter((p): p is string => !!p);
    const ioc = iocs.find((i) => paths.some((p) => fileMatch(i, p) || (i.sha256 && fileSha(p) === i.sha256.toLowerCase())) || (i.label && [`${r}:${item.id}`, item.label].some((n) => glob(i.label).test(n))));
    if (ioc) hits.push({ receptor: r, item, ioc });
  }
  return hits;
}

const WHY: [RegExp, string][] = [
  [/^launchagents:daemon\//, 'runs as root, usually from boot'],
  [/^launchagents:/, 'runs in the background, usually every time you log in'],
  [/^crontab:/, 'runs on a timer'],
  [/^shellrc:/, 'runs every time you open a terminal'],
  [/^ssh:SHA256:/, 'lets the owner of this key log in to your Mac'],
  [/^ssh:/, 'runs when you connect with ssh'],
  [/^browsers:/, 'runs inside your browser and can read the pages you visit'],
  [/^git:/, 'runs during everyday git commands'],
  [/^editors:/, 'runs inside your editor'],
  [/^(claude|projects):.*hook\/SessionStart\//, 'runs at every Claude Code session start'],
  [/^claude:.*plugin\//, 'adds code to every Claude Code session'],
  [/^claude:/, 'runs during Claude Code sessions'],
  [/^(mcp|codex):/, 'starts together with your AI tool'],
  [/^npmrc:/, 'changes what npm installs and how it runs scripts'],
  [/^projects:.*folderOpen/, 'runs when you open this folder in VS Code'],
  [/^projects:.*\.git\/hooks\//, 'runs during git commands in this repo'],
  [/^projects:.*hook\//, 'runs during AI agent sessions in this repo'],
  [/^projects:.*(mcp\.json|\.gemini\/settings\.json)\//, 'starts when your AI tool opens this repo'],
  [/^projects:/, 'runs when you open or work in this repo'],
  [/^hammerspoon:/, 'runs when Hammerspoon starts, usually at login'],
  [/^menubar:/, 'runs over and over while the menu bar app is open'],
  [/^terminal:/, 'runs every time you open a terminal window'],
  [/^apps:dock\//, 'sits in your Dock, one click away'],
  [/^apps:reopen\//, 'opens by itself at your next login'],
  [/^plugins:/, 'loaded by a macOS app or panel when it starts'],
  [/^legacy:/, 'runs on a schedule or at boot (old mechanism)'],
];
const why = (r: string, i: Item) => WHY.find(([re]) => re.test(`${r}:${i.id}`))?.[1] ?? '';

function printErrors(errors: Record<string, string>) {
  for (const [r, e] of Object.entries(errors)) console.log(`  ! receptor ${r} failed: ${e}`);
}

const save = (snap: Snap, created?: string) => writeFileSync(SELF, JSON.stringify({ created: created ?? new Date().toISOString(), updated: new Date().toISOString(), receptors: snap }, null, 2) + '\n');
const sign = { new: '+', changed: '~', removed: '-' };
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
const color = { new: '1;31', changed: '1;33', removed: '32' };
const quote = (p: string) => /[^\w@%+=:,./~-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
const tilde = (p: string) => p.startsWith(homedir() + '/') && quote(p) === p ? '~' + p.slice(homedir().length) : quote(p);
const look = (p: string) => `${p.endsWith('.plist') ? 'plutil -p' : existsSync(p) && statSync(p).isDirectory() ? 'ls -la' : 'cat'} ${tilde(p)}`;
const signTag = (s?: Signer) => !s ? '' : risky(s) ? ' ' + paint('1;31', `[SUSPICIOUS: ${signText(s)}]`) : paint('2', ` (${signText(s)})`);
const hitJson = (h: Hit) => ({ receptor: h.receptor, id: h.item.id, path: h.item.path, ioc: h.ioc });

function printBad(hits: Hit[]) {
  if (!hits.length) return;
  console.log(paint('1;31', `KNOWN-BAD: ${hits.length} item(s) match a published attack indicator`));
  for (const h of hits) {
    console.log(`  ${paint('1;31', `! ${h.receptor}:${h.item.id}`)}  ${paint('2', `${h.ioc.pack} ${h.ioc.file ?? h.ioc.label ?? h.ioc.sha256?.slice(0, 12)}`)}`);
    if (h.ioc.note) console.log(`      ${h.ioc.note}`);
    if (h.ioc.url) console.log(`      ${paint('2', h.ioc.url)}`);
  }
  for (const a of new Set(hits.map((h) => h.ioc.advice).filter(Boolean))) console.log(paint('1;33', `  ${a}`));
  console.log('');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) return existsSync(SELF) ? diff([]) : init([]);
  if (cmd === 'init') return init(args);
  if (cmd === 'diff') return diff(args);
  if (cmd === 'check') return check(args);
  if (cmd === 'explain') return explain(args[0]);
  if (cmd === 'approve') {
    if (!existsSync(SELF)) return fail(`no baseline at ${SELF}, run: thymus init`);
    const self = readJson(SELF, {});
    const { snap, errors } = await snapshot();
    return approve(self, compare(self.receptors, snap, errors, readJson(KNOWN, [])), args);
  }
  if (cmd === 'list') {
    const self = readJson(SELF, null);
    if (!self) return fail(`no baseline at ${SELF}, run: thymus init`);
    const only = args.includes('--suspicious');
    for (const [r, all] of Object.entries(self.receptors as Snap)) {
      const items = Object.values(all).filter((i) => !only || risky(i.signer));
      if (!items.length && only) continue;
      console.log(`${r} (${items.length})`);
      for (const i of items) console.log(`  ${r}:${i.id}  ${i.label === i.id ? '' : i.label}${i.signer ? `  [${signText(i.signer)}]` : ''}`.trimEnd());
    }
    return 0;
  }
  if (cmd === 'schedule') return schedule(args[0]);
  if (cmd === 'receptors') {
    const { snap, errors } = await snapshot();
    for (const [name, file] of receptors()) console.log(`${name.padEnd(20)} ${errors[name] ? 'ERROR ' + errors[name] : String(Object.keys(snap[name]).length).padStart(5) + ' items'}  ${file}`);
    return 0;
  }
  console.log('usage: thymus (first run: init, later: diff) | init [--force] | diff [--json] [--notify] | check [--json] [--no-global] | explain <receptor:id> | approve <receptor:id ...> | approve --all | list [--suspicious] | receptors | schedule install|uninstall|status');
  return ['help', '-h', '--help'].includes(cmd) ? 0 : 2;
}

async function init(args: string[]) {
  if (existsSync(SELF) && !args.includes('--force')) return fail(`baseline already exists at ${SELF} (use --force to overwrite)`);
  mkdirSync(HOME, { recursive: true });
  if (!existsSync(KNOWN)) copyFileSync(join(ROOT, 'known.default.json'), KNOWN);
  const { snap, errors } = await snapshot();
  save(snap);
  const all = Object.entries(snap).flatMap(([receptor, items]) => Object.values(items).map((item) => ({ receptor, item })));
  const isKnown = known(readJson(KNOWN, []));
  const signed = all.filter((x) => x.item.signer), sus = signed.filter((x) => risky(x.item.signer) && !isKnown(x.receptor, x.item));
  const hits = infected(snap, antibodies());
  printBad(hits);
  console.log(paint('1', `thymus: learned ${all.length} items from ${Object.keys(snap).length} receptors into ${SELF}`));
  console.log('  ' + Object.entries(snap).map(([r, i]) => [r, Object.keys(i).length] as const).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', '));
  console.log(`  signing: ${signed.length} programs checked, ${sus.length} suspicious (unsigned, ad-hoc, missing, or a script in a writable folder)`);
  for (const x of sus.slice(0, 8)) console.log(`    ${paint('1;31', '!')} ${x.item.label}  ${paint('2', `[${signText(x.item.signer!)}]  thymus explain ${x.receptor}:${x.item.id}`)}`);
  if (sus.length > 8) console.log(`    and ${sus.length - 8} more: thymus list --suspicious`);
  console.log(`  known-bad: ${hits.length ? paint('1;31', `${hits.length}, see the top`) : 'nothing matches the published indicators'}`);
  printErrors(errors);
  console.log('\nNext: run thymus again any time to see only what changed. thymus check looks up your packages in osv.dev, thymus schedule install runs it daily.');
  return hits.length ? 1 : 0;
}

async function diff(args: string[]) {
  if (!existsSync(SELF)) return fail(`no baseline at ${SELF}, run: thymus init`);
  const self = readJson(SELF, {});
  const { snap, errors } = await snapshot();
  const changes = compare(self.receptors, snap, errors, readJson(KNOWN, []));
  const hits = infected(snap, antibodies());
  const alarming = changes.filter((c) => c.change !== 'removed');
  const code = alarming.length || hits.length ? 1 : 0;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ knownBad: hits.map(hitJson), changes: changes.map((c) => ({ receptor: c.receptor, change: c.change, ...c.item, why: why(c.receptor, c.item), suspicious: risky(c.item.signer) })), errors }, null, 2));
    return code;
  }
  printBad(hits);
  const count = (k: string) => changes.filter((c) => c.change === k).length;
  console.log(paint('1', `thymus: ${count('new')} new, ${count('changed')} changed, ${count('removed')} removed since ${new Date(self.updated).toLocaleString('sv').slice(0, 16)}`));
  let last = '';
  for (const c of [...changes].sort((a, b) => a.receptor.localeCompare(b.receptor))) {
    if (c.receptor !== last) console.log(`\n${paint('1;4', last = c.receptor)}`);
    const id = `${c.receptor}:${c.item.id}`, s = c.item.signer, head = `${sign[c.change]} ${c.item.label === c.item.id ? id : c.item.label}`;
    console.log(`  ${s?.kind === 'apple' ? paint('2', `${head} (Apple)`) : paint(color[c.change], head) + signTag(s)}`);
    if (c.change !== 'removed' && why(c.receptor, c.item)) console.log(`      ${why(c.receptor, c.item)}`);
    if (c.item.label !== c.item.id) console.log(`      ${paint('2', id)}`);
    if (c.item.path) console.log(`      ${c.change === 'removed' ? paint('2', c.item.path) : 'look: ' + look(c.item.path)}`);
  }
  if (Object.keys(errors).length) console.log('');
  printErrors(errors);
  if (alarming.length) {
    console.log('\nKnown and wanted?  thymus approve <receptor:id> ...   (or --all)');
    console.log('Not sure?  thymus explain <receptor:id>, run the look: command, see where it came from (ls -l@ <path>, git log -- <file>).');
    console.log('Thymus never deletes anything: remove it by hand, then approve the removal.');
  }
  if (code && args.includes('--notify')) spawnSync('osascript', ['-e', `display notification "${hits.length ? `${hits.length} KNOWN-BAD, ` : ''}${alarming.length} new or changed. Run: thymus diff" with title "Thymus" sound name "Basso"`]);
  return code;
}

async function check(args: string[]) {
  mkdirSync(HOME, { recursive: true });
  const iocs = antibodies(), fileIocs = iocs.filter((i) => i.file);
  const pkgs: Pkg[] = [], locks: string[] = [];
  const { snap } = await snapshot();
  const hits = infected(snap, iocs);
  const ls = (d: string) => { try { return readdirSync(d); } catch { return []; } };
  const sweep = (dir: string, names: Iterable<string>) => {
    for (const n of names) {
      const p = join(dir, n), ioc = fileIocs.find((i) => fileMatch(i, p));
      if (ioc && !hits.some((h) => h.item.path === p)) hits.push({ receptor: 'files', item: { id: tilde(p), label: p, path: p, hash: '' }, ioc });
    }
  };
  // Repo files by name only: each repo dir, its .github/workflows and the root of every installed package.
  for (const r of roots()) walk(r, (dir, names) => {
    sweep(dir, names);
    if (names.has('.github')) sweep(join(dir, '.github/workflows'), ls(join(dir, '.github/workflows')));
    for (const n of names) if (LOCKFILES.has(n)) { try { pkgs.push(...lockfile(tilde(join(dir, n)), readFileSync(join(dir, n), 'utf8'))); locks.push(join(dir, n)); } catch {} }
    if (names.has('node_modules')) for (const m of ls(join(dir, 'node_modules'))) {
      const p = join(dir, 'node_modules', m);
      for (const pkg of m.startsWith('@') ? ls(p).map((s) => join(p, s)) : [p]) sweep(pkg, ls(pkg));
    }
  });
  const global = !args.includes('--no-global') && which('npm') !== 'npm';
  if (global) pkgs.push(...globalNpm());
  const priv: string[] = readJson(join(HOME, 'config.json'), {}).private ?? [];
  const pub = pkgs.filter((p) => !priv.some((g) => glob(g).test(p.name)));
  let mal;
  try { mal = await malicious(pub, join(HOME, 'osv-cache.json')); } catch (e: any) { return fail(`osv.dev lookup failed: ${e.cause?.message ?? e.message}`); }
  const versions = new Set(pub.map((p) => `${p.eco}:${p.name}@${p.version}`)).size;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ knownBad: hits.map(hitJson), malicious: mal, lockfiles: locks, packages: versions, skippedPrivate: pkgs.length - pub.length }, null, 2));
    return mal.length || hits.length ? 1 : 0;
  }
  printBad(hits);
  console.log(paint('1', `thymus check: ${versions} package versions from ${locks.length} lockfiles${global ? ' and global npm' : ''} looked up in osv.dev, ${mal.length} malicious`));
  for (const m of mal) for (const id of m.ids) console.log(`  ${paint('1;31', `MAL ${m.name}@${m.version}`)} (${m.eco})  in ${m.where}\n      https://osv.dev/vulnerability/${id}`);
  if (mal.length) console.log('\nA lockfile pins a version osv.dev lists as malicious. Open the link: if that version was ever installed here, remove it, reinstall from a fixed lockfile, run thymus diff for planted persistence, then rotate the tokens this machine could read.');
  return mal.length || hits.length ? 1 : 0;
}

async function explain(q?: string) {
  if (!q) return fail('usage: thymus explain <receptor:id>');
  const { snap } = await snapshot();
  const find = (s: Snap) => Object.entries(s ?? {}).flatMap(([receptor, items]) => Object.values(items).filter((i) => q === `${receptor}:${i.id}` || q === i.id).map((item) => ({ receptor, item })))[0];
  const cur = find(snap), old = find(readJson(SELF, {}).receptors), x = cur ?? old;
  if (!x) return fail(`no item ${q}, see thymus list`);
  const { receptor: r, item } = x, s = item.signer;
  const row = (k: string, v?: string) => v && console.log(`  ${(k + ':').padEnd(11)}${v}`);
  console.log(paint('1', `${r}:${item.id}`));
  row('what', item.label);
  row('trigger', why(r, item));
  row('status', !old ? 'new since your baseline' : !cur ? 'removed since your baseline' : old.item.hash === cur.item.hash ? 'in your baseline, unchanged' : 'changed since your baseline');
  row('path', item.path && tilde(item.path));
  row('signer', s && `${signText(s)}${s.org ? `, ${s.org}` : ''}  ${tilde(s.path)}${risky(s) ? '  ' + paint('1;31', 'SUSPICIOUS') : ''}`);
  row('look', item.path && look(item.path));
  for (const h of infected({ [r]: { [item.id]: item } }, antibodies())) row('KNOWN-BAD', paint('1;31', `${h.ioc.pack} ${h.ioc.file ?? h.ioc.label ?? h.ioc.sha256}${h.ioc.note ? `: ${h.ioc.note}` : ''}  ${h.ioc.url ?? ''}`));
  return 0;
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

const AGENT = 'dev.thymus.daily';
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function schedule(action?: string) {
  const plist = join(homedir(), 'Library/LaunchAgents', `${AGENT}.plist`);
  // Talk to launchd only when HOME is the real home, so a fake HOME (tests, demo) never loads a real agent.
  const real = homedir() === userInfo().homedir;
  const launchctl = (...a: string[]) => real ? spawnSync('launchctl', a, { stdio: 'ignore' }).status : null;
  const target = `gui/${process.getuid!()}`;
  if (action === 'install') {
    if (!existsSync(SELF)) return fail(`no baseline at ${SELF}, run: thymus init`);
    // Prefer a PATH symlink like /opt/homebrew/bin/node so a brew upgrade does not break the agent.
    const node = (process.env.PATH ?? '').split(':').map((d) => join(d, 'node')).find((p) => { try { return realpathSync(p) === realpathSync(process.execPath); } catch { return false; } }) ?? process.execPath;
    const argv = [node, '--no-warnings', join(ROOT, 'bin/thymus'), 'diff', '--notify'];
    const log = join(HOME, 'last-diff.txt');
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>THYMUS_HOME</key><string>${xml(HOME)}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`);
    const known: Card[] = readJson(KNOWN, []);
    if (!known.some((k) => k.id === `user/${AGENT}`)) writeFileSync(KNOWN, JSON.stringify([...known, { receptor: 'launchagents', id: `user/${AGENT}`, label: '*/bin/thymus diff --notify' }], null, 2) + '\n');
    launchctl('bootout', `${target}/${AGENT}`);
    const st = launchctl('bootstrap', target, plist);
    console.log(`thymus: wrote ${plist}, runs daily at 10:00 and at login, notifies only when something is new or changed`);
    console.log(st === null ? '  HOME is not your real home, so launchd was not touched' : st ? `  ! launchctl bootstrap failed (${st})` : `  loaded into launchd, output goes to ${log}`);
    return st ? 1 : 0;
  }
  if (action === 'uninstall') {
    launchctl('bootout', `${target}/${AGENT}`);
    rmSync(plist, { force: true });
    console.log(`thymus: removed ${plist}`);
    return 0;
  }
  if (action === 'status') {
    const loaded = launchctl('print', `${target}/${AGENT}`);
    const log = join(HOME, 'last-diff.txt');
    console.log(`plist:    ${existsSync(plist) ? plist : 'not installed'}`);
    console.log(`launchd:  ${loaded === null ? 'not checked (fake HOME)' : loaded ? 'not loaded' : 'loaded'}`);
    console.log(`last run: ${existsSync(log) ? `${statSync(log).mtime.toLocaleString('sv').slice(0, 16)}  ${readFileSync(log, 'utf8').split('\n')[0]}` : 'never'}`);
    return 0;
  }
  return fail('usage: thymus schedule install|uninstall|status');
}

function fail(msg: string) {
  console.error(`thymus: ${msg}`);
  return 2;
}

process.exitCode = await main();
