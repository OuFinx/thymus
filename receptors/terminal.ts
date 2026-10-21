// Commands a terminal app runs when a window opens: Terminal.app profiles, iTerm2 profiles and AutoLaunch scripts, Ghostty config.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { plist } from './launchagents.ts';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const home = homedir(), prefs = join(home, 'Library/Preferences'), support = join(home, 'Library/Application Support');
const read = (p: string) => existsSync(p) ? (() => { try { return plist(p); } catch { return {}; } })() : {};

export default () => {
  const items = [];
  const add = (id: string, label: string, path: string, v: unknown) => items.push({ id, label, path, hash: sha(JSON.stringify(v)) });
  const term = join(prefs, 'com.apple.Terminal.plist'), t = read(term);
  for (const [name, p] of Object.entries<any>(t['Window Settings'] ?? {})) {
    if (p.CommandString) add(`Terminal/${name}/CommandString`, `Terminal profile ${name} runs: ${p.CommandString}`, term, p.CommandString);
    if (p.Shell) add(`Terminal/${name}/Shell`, `Terminal profile ${name} shell: ${p.Shell}`, term, p.Shell);
  }
  if (t.Shell) add('Terminal/Shell', `Terminal shell: ${t.Shell}`, term, t.Shell);
  const iterm = join(prefs, 'com.googlecode.iterm2.plist');
  for (const b of read(iterm)['New Bookmarks'] ?? []) {
    if (b['Custom Command'] === 'Yes' && b.Command) add(`iTerm2/${b.Guid}/Command`, `iTerm2 profile ${b.Name} runs: ${b.Command}`, iterm, b.Command);
    if (b['Initial Text']) add(`iTerm2/${b.Guid}/InitialText`, `iTerm2 profile ${b.Name} types: ${b['Initial Text']}`, iterm, b['Initial Text']);
  }
  const auto = join(support, 'iTerm2/Scripts/AutoLaunch');
  let scripts: string[] = [];
  try { scripts = readdirSync(auto).filter((f) => !f.startsWith('.')); } catch {}
  for (const f of scripts) { try { add(`iTerm2/AutoLaunch/${f}`, `iTerm2 AutoLaunch script ${f}`, join(auto, f), sha(readFileSync(join(auto, f)))); } catch { add(`iTerm2/AutoLaunch/${f}`, `iTerm2 AutoLaunch ${f}`, join(auto, f), f); } }
  for (const path of [join(home, '.config/ghostty/config'), join(support, 'com.mitchellh.ghostty/config')]) {
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const [, key, value] of text.matchAll(/^\s*(command|initial-command)\s*=\s*(.*?)\s*$/gm)) add(`Ghostty/${path.includes('.config') ? 'config' : 'support'}/${key}`, `Ghostty ${key}: ${value}`, path, value);
  }
  return items;
};
