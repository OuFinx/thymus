// Plugin bundles macOS loads into apps and panels: preference panes, screen savers, color pickers, QuickLook and Spotlight plugins, folder action scripts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const home = homedir();
const kinds = ['PreferencePanes', 'Screen Savers', 'ColorPickers', 'QuickLook', 'Spotlight'];
const dirs = [...kinds.flatMap((k) => [join(home, 'Library', k), join('/Library', k)]), join(home, 'Library/Scripts/Folder Action Scripts')];

export default () => {
  const items = [];
  for (const dir of dirs) {
    let ents: string[] = [];
    // Only bundles (Name.saver, Name.qlgenerator...) and loose scripts, not caches macOS keeps in the same dirs.
    try { ents = readdirSync(dir).filter((e) => !e.startsWith('.') && e.includes('.')).sort(); } catch {}
    for (const e of ents) {
      const path = join(dir, e);
      let hash = 'unreadable', bundle = false;
      // A bundle changes with its Info.plist (version, executable); a loose script with its content.
      try { bundle = statSync(path).isDirectory(); hash = sha(readFileSync(bundle ? join(path, 'Contents/Info.plist') : path)); } catch {}
      items.push({ id: path.replace(home, '~'), label: path.replace(home, '~'), path, hash, ...(bundle ? { exec: [path] } : {}) });
    }
  }
  return items;
};
