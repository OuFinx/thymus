// Project-level autorun files inside your repos: what Mini Shai-Hulud plants so that opening a repo runs it.
// Roots come from ~/.thymus/config.json {"roots": [...]}, default is the usual code dirs, never TCC-protected ones.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { settingsItems } from './claude.ts';
import { serverItems } from './mcp.ts';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const home = homedir();
const tilde = (p: string) => p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
const DEFAULT_ROOTS = ['Work', 'Projects', 'projects', 'code', 'Code', 'src', 'dev', 'Developer', 'repos', 'git', 'GitHub'];
const PRUNE = new Set(['node_modules', 'vendor', 'build', 'dist', 'out', 'target', 'venv', 'env', '__pycache__', 'Pods', 'DerivedData', 'coverage', 'bower_components']);
const DEPTH = 5;
const SCRIPT = new Set(['.js', '.mjs', '.cjs', '.ts', '.sh', '.py']);
// Workspace settings that point at a binary or switch off a safety prompt.
const EXEC_SETTING = /(executablePath|interpreterPath|\.path$|\.shell\b|terminal\.integrated\.(env|profiles|automationProfile)|task\.allowAutomaticTasks|autoApprove|chat\.permissions|chat\.tools)/i;

// VS Code files are JSONC: drop comments and trailing commas, leave strings alone.
export const jsonc = (s: string) => JSON.parse(s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '$1').replace(/,(\s*[}\]])/g, '$1'));
const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

export function roots() {
  const cfg = join(process.env.THYMUS_HOME || join(home, '.thymus'), 'config.json');
  const list: string[] = existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')).roots ?? [] : DEFAULT_ROOTS.map((d) => join(home, d));
  const seen = new Set<string>();
  return list.map((r) => r.replace(/^~(?=\/|$)/, home)).filter((r) => existsSync(r) && !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
}

function scan(dir: string, names: Set<string>, items: any[]) {
  const add = (id: string, label: string, path: string, v: unknown) => items.push({ id, label, path, hash: sha(typeof v === 'string' ? v : JSON.stringify(v)) });
  const scripts = (sub: string) => {
    let files: string[] = [];
    try { files = readdirSync(join(dir, sub)); } catch {}
    for (const f of files) {
      if (!SCRIPT.has(extname(f))) continue;
      const path = join(dir, sub, f), text = read(path);
      if (text !== null) add(tilde(path), `script in ${sub}/: ${f}`, path, text);
    }
  };
  if (names.has('.claude')) {
    for (const f of ['settings.json', 'settings.local.json']) { const p = join(dir, '.claude', f); items.push(...settingsItems(p, tilde(p))); }
    scripts('.claude');
  }
  if (names.has('.gemini')) { const p = join(dir, '.gemini/settings.json'); items.push(...settingsItems(p, tilde(p)), ...serverItems(tilde(p), p, 'mcpServers')); }
  if (names.has('.mcp.json')) { const p = join(dir, '.mcp.json'); items.push(...serverItems(tilde(p), p, 'mcpServers')); }
  if (names.has('.cursor')) {
    const m = join(dir, '.cursor/mcp.json'), h = join(dir, '.cursor/hooks.json');
    items.push(...serverItems(tilde(m), m, 'mcpServers'));
    const text = read(h);
    if (text !== null) {
      try {
        for (const [event, list] of Object.entries<any[]>(jsonc(text).hooks ?? {})) for (const x of list ?? []) add(`${tilde(h)}:hook/${event}/${x.command}`, `Cursor ${event} hook: ${x.command}`, h, x);
      } catch { add(`${tilde(h)}:(unparsed)`, 'Cursor hooks.json, not parseable, tracking whole file', h, text); }
    }
  }
  if (names.has('.vscode')) {
    const t = join(dir, '.vscode/tasks.json'), tasks = read(t);
    if (tasks !== null) {
      try {
        for (const task of jsonc(tasks).tasks ?? []) {
          if (task.runOptions?.runOn !== 'folderOpen') continue;
          const cmd = [task.osx?.command ?? task.command, ...(task.osx?.args ?? task.args ?? [])].filter(Boolean).join(' ');
          add(`${tilde(t)}:folderOpen/${task.label ?? cmd}`, `RUNS ON FOLDER OPEN: ${cmd}`, t, task);
        }
      } catch { if (tasks.includes('folderOpen')) add(`${tilde(t)}:(unparsed)`, 'tasks.json mentions folderOpen but is not parseable', t, tasks); }
    }
    const s = join(dir, '.vscode/settings.json'), settings = read(s);
    try {
      for (const [k, v] of Object.entries<any>(settings ? jsonc(settings) : {})) {
        // Objects (terminal env) show only their keys, values may be secrets.
        if (EXEC_SETTING.test(k)) add(`${tilde(s)}:${k}`, v && typeof v === 'object' ? `${k}: {${Object.keys(v).join(', ')}}` : `${k}=${v}`, s, v);
      }
    } catch {}
    const m = join(dir, '.vscode/mcp.json');
    items.push(...serverItems(tilde(m), m, 'servers'));
    scripts('.vscode');
  }
  if (names.has('.git')) {
    const hooks = join(dir, '.git/hooks');
    let files: string[] = [];
    try { files = readdirSync(hooks); } catch {}
    for (const f of files) {
      const path = join(hooks, f);
      try {
        if (f.endsWith('.sample') || !statSync(path).isFile() || !(statSync(path).mode & 0o111)) continue;
        add(tilde(path), `git ${f} hook`, path, readFileSync(path));
      } catch {}
    }
    const cfg = join(dir, '.git/config');
    for (const [, key, value] of (read(cfg) ?? '').matchAll(/^\s*(hooksPath|fsmonitor)\s*=\s*(.*)$/gim)) add(`${tilde(cfg)}:core.${key.toLowerCase()}`, `git core.${key}=${value}`, cfg, value);
  }
}

// Also used by thymus check to find lockfiles and IOC file names.
export function walk(dir: string, visit: (dir: string, names: Set<string>) => void, depth = DEPTH) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  visit(dir, new Set(ents.map((e) => e.name)));
  if (depth > 0) for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !PRUNE.has(e.name)) walk(join(dir, e.name), visit, depth - 1);
}

export default () => {
  const items = [];
  for (const r of roots()) walk(r, (dir, names) => scan(dir, names, items));
  return items;
};
