// ~/.ssh/authorized_keys (one item per key, id = SHA256 fingerprint) plus ~/.ssh/rc and ~/.ssh/config.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sha = (s: string | Buffer, enc: 'hex' | 'base64' = 'hex') => createHash('sha256').update(s).digest(enc);
const dir = join(homedir(), '.ssh');
const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

export default () => {
  const items = [];
  for (const f of ['authorized_keys', 'authorized_keys2']) {
    const path = join(dir, f);
    for (const line of (read(path) ?? '').split('\n').map((l) => l.trim())) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/), t = parts.findIndex((p) => /^(ssh-|ecdsa-|sk-)/.test(p));
      if (t < 0) continue;
      const fp = 'SHA256:' + sha(Buffer.from(parts[t + 1] ?? '', 'base64'), 'base64').replace(/=+$/, '');
      items.push({ id: fp, label: `${parts[t]} ${parts.slice(t + 2).join(' ')}${t > 0 ? ' [with options]' : ''}`.trim(), path, hash: sha(line) });
    }
  }
  for (const f of ['rc', 'config']) {
    const path = join(dir, f), text = read(path);
    if (text !== null) items.push({ id: `~/.ssh/${f}`, label: `~/.ssh/${f}`, path, hash: sha(text) });
  }
  return items;
};
