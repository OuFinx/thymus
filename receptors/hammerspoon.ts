// Hammerspoon Lua config: runs when Hammerspoon starts. One item per .lua file, one per Spoon, plus a moved config file (MJConfigFile).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { plist } from './launchagents.ts';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const home = homedir(), dir = join(home, '.hammerspoon');
const pref = join(home, 'Library/Preferences/org.hammerspoon.Hammerspoon.plist');

function lua(d: string, depth = 4): string[] {
  let ents: string[] = [];
  try { ents = readdirSync(d).sort(); } catch {}
  return ents.flatMap((e) => {
    const p = join(d, e);
    try { return statSync(p).isDirectory() ? (depth && !e.startsWith('.') ? lua(p, depth - 1) : []) : e.endsWith('.lua') ? [p] : []; } catch { return []; }
  });
}

export default () => {
  const items = [];
  for (const p of lua(dir)) {
    const rel = relative(dir, p), spoon = rel.match(/^Spoons\/([^/]+\.spoon)\//)?.[1];
    if (!spoon) items.push({ id: rel, label: `~/.hammerspoon/${rel}`, path: p, hash: sha(readFileSync(p)) });
  }
  let spoons: string[] = [];
  try { spoons = readdirSync(join(dir, 'Spoons')).filter((s) => s.endsWith('.spoon')).sort(); } catch {}
  for (const s of spoons) {
    const files = lua(join(dir, 'Spoons', s));
    items.push({ id: `Spoons/${s}`, label: `Spoon ${s}`, path: join(dir, 'Spoons', s), hash: sha(files.map((f) => f + sha(readFileSync(f))).join('\n')) });
  }
  if (existsSync(pref)) {
    try {
      const cfg = plist(pref).MJConfigFile;
      if (cfg) items.push({ id: 'MJConfigFile', label: `config moved to ${cfg}`, path: pref, hash: sha(cfg) });
    } catch {}
  }
  return items;
};
