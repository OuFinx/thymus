// VS Code family extensions (id = publisher.name, label shows version) and user-level tasks.json.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const home = homedir();
const extDirs = { vscode: '.vscode/extensions', 'vscode-insiders': '.vscode-insiders/extensions', cursor: '.cursor/extensions', windsurf: '.windsurf/extensions' };
const apps = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf'];

export default () => {
  const items = [];
  for (const [editor, rel] of Object.entries(extDirs)) {
    let dirs: string[] = [];
    try { dirs = readdirSync(join(home, rel)).sort(); } catch {}
    for (const d of dirs) {
      const path = join(home, rel, d);
      try {
        const raw = readFileSync(join(path, 'package.json'), 'utf8'), pkg = JSON.parse(raw);
        const name = `${pkg.publisher}.${pkg.name}`.toLowerCase();
        items.push({ id: `${editor}/${name}`, label: `${name}@${pkg.version}`, path, hash: sha(raw) });
      } catch {}
    }
  }
  for (const app of apps) {
    const path = join(home, 'Library/Application Support', app, 'User/tasks.json');
    try { items.push({ id: `${app}/tasks.json`, label: `${app} user tasks.json`, path, hash: sha(readFileSync(path, 'utf8')) }); } catch {}
  }
  return items;
};
