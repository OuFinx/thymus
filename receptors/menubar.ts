// xbar, BitBar and SwiftBar plugins: scripts the menu bar app runs on a timer. Plugin dirs come from each app's preferences.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { plist } from './launchagents.ts';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const home = homedir(), prefs = join(home, 'Library/Preferences');
const pref = (file: string, key: string) => { try { return existsSync(join(prefs, file)) ? plist(join(prefs, file))[key]?.replace(/^~(?=\/)/, home) : undefined; } catch { return undefined; } };

export default () => {
  const dirs = {
    xbar: join(home, 'Library/Application Support/xbar/plugins'),
    bitbar: pref('com.matryer.BitBar.plist', 'pluginsDirectory'),
    swiftbar: pref('com.ameba.SwiftBar.plist', 'PluginDirectory'),
  };
  const items = [];
  for (const [app, dir] of Object.entries(dirs)) {
    if (!dir) continue;
    let files: string[] = [];
    try { files = readdirSync(dir).sort(); } catch {}
    for (const f of files) {
      const path = join(dir, f);
      try {
        if (f.startsWith('.') || !statSync(path).isFile()) continue;
        items.push({ id: `${app}/${f}`, label: `${app} plugin ${f}`, path, hash: sha(readFileSync(path)) });
      } catch {}
    }
  }
  return items;
};
