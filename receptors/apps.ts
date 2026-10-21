// Apps pinned in the Dock and apps macOS re-opens at login (loginwindow TALAppsToRelaunchAtLogin). exec = the app, for the signing check.
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plist } from './launchagents.ts';

const prefs = join(homedir(), 'Library/Preferences');

export default () => {
  const items = [];
  const add = (kind: string, key: string, path: string, from: string) => items.push({ id: `${kind}/${key}`, label: path, path: from, hash: path, exec: [path] });
  const dock = join(prefs, 'com.apple.dock.plist');
  try {
    for (const a of plist(dock)['persistent-apps'] ?? []) {
      const url = a['tile-data']?.['file-data']?._CFURLString;
      if (!url?.startsWith('file://')) continue;
      const path = fileURLToPath(url).replace(/\/$/, '');
      add('dock', a['tile-data']['bundle-identifier'] ?? path, path, dock);
    }
  } catch {}
  let hosts: string[] = [];
  try { hosts = readdirSync(join(prefs, 'ByHost')).filter((f) => f.startsWith('com.apple.loginwindow.') && f.endsWith('.plist')); } catch {}
  for (const f of hosts) {
    const p = join(prefs, 'ByHost', f);
    try { for (const a of plist(p).TALAppsToRelaunchAtLogin ?? []) if (a.Path) add('reopen', a.BundleID ?? a.Path, a.Path, p); } catch {}
  }
  return items;
};
