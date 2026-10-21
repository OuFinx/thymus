// Chromium-family browser extensions per profile (id = browser/profile/extension id).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const support = join(homedir(), 'Library/Application Support');
const browsers = { chrome: 'Google/Chrome', brave: 'BraveSoftware/Brave-Browser', arc: 'Arc/User Data', edge: 'Microsoft Edge', chromium: 'Chromium', vivaldi: 'Vivaldi' };
const ls = (p: string) => { try { return readdirSync(p).sort(); } catch { return []; } };

function nameOf(dir: string, m: any) {
  const msg = /^__MSG_(.+)__$/.exec(m.name ?? '')?.[1]?.toLowerCase();
  if (!msg) return m.name;
  try {
    const all = JSON.parse(readFileSync(join(dir, '_locales', m.default_locale ?? 'en', 'messages.json'), 'utf8'));
    return Object.entries<any>(all).find(([k]) => k.toLowerCase() === msg)?.[1]?.message ?? m.name;
  } catch { return m.name; }
}

export default () => {
  const items = [];
  for (const [browser, rel] of Object.entries(browsers)) {
    const root = join(support, rel);
    for (const profile of ls(root).filter((p) => existsSync(join(root, p, 'Extensions')))) {
      for (const ext of ls(join(root, profile, 'Extensions')).filter((e) => /^[a-p]{32}$/.test(e))) {
        const version = ls(join(root, profile, 'Extensions', ext)).filter((v) => !v.startsWith('.')).pop();
        if (!version) continue;
        const dir = join(root, profile, 'Extensions', ext, version);
        try {
          const raw = readFileSync(join(dir, 'manifest.json'), 'utf8');
          items.push({ id: `${browser}/${profile}/${ext}`, label: `${nameOf(dir, JSON.parse(raw))}@${version}`, path: dir, hash: sha(raw) });
        } catch {}
      }
    }
  }
  return items;
};
