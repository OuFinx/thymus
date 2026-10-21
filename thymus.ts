import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { homedir, userInfo } from 'node:os';
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
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
const color = { new: '1;31', changed: '1;33', removed: '32' };
const quote = (p: string) => /[^\w@%+=:,./~-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
const tilde = (p: string) => p.startsWith(homedir() + '/') && quote(p) === p ? '~' + p.slice(homedir().length) : quote(p);
const look = (p: string) => `${p.endsWith('.plist') ? 'plutil -p' : existsSync(p) && statSync(p).isDirectory() ? 'ls -la' : 'cat'} ${tilde(p)}`;

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
    console.log(paint('1', `thymus: ${count('new')} new, ${count('changed')} changed, ${count('removed')} removed since ${new Date(self.updated).toLocaleString('sv').slice(0, 16)}`));
    let last = '';
    for (const c of [...changes].sort((a, b) => a.receptor.localeCompare(b.receptor))) {
      if (c.receptor !== last) console.log(`\n${paint('1;4', last = c.receptor)}`);
      const id = `${c.receptor}:${c.item.id}`;
      console.log(`  ${paint(color[c.change], `${sign[c.change]} ${c.item.label === c.item.id ? id : c.item.label}`)}`);
      if (c.item.label !== c.item.id) console.log(`      ${paint('2', id)}`);
      if (c.item.path) console.log(`      ${c.change === 'removed' ? paint('2', c.item.path) : 'look: ' + look(c.item.path)}`);
    }
    if (Object.keys(errors).length) console.log('');
    printErrors(errors);
    if (alarming.length) {
      console.log('\nKnown and wanted?  thymus approve <receptor:id> ...   (or --all)');
      console.log('Not sure?  run the look: command, see where it came from (ls -l@ <path>, git log -- <file>), search the label.');
      console.log('Thymus never deletes anything: remove it by hand, then approve the removal.');
      if (args.includes('--notify')) spawnSync('osascript', ['-e', `display notification "${alarming.length} new or changed. Run: thymus diff" with title "Thymus" sound name "Basso"`]);
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
  if (cmd === 'schedule') return schedule(args[0]);
  if (cmd === 'receptors') {
    const { snap, errors } = await snapshot();
    for (const [name, file] of receptors()) console.log(`${name.padEnd(20)} ${errors[name] ? 'ERROR ' + errors[name] : String(Object.keys(snap[name]).length).padStart(5) + ' items'}  ${file}`);
    return 0;
  }
  console.log('usage: thymus init [--force] | diff [--json] [--notify] | approve <receptor:id ...> | approve --all | list | receptors | schedule install|uninstall|status');
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
