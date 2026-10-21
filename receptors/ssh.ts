// ~/.ssh/authorized_keys (one item per key, id = SHA256 fingerprint), ~/.ssh/rc, and ~/.ssh/config directives that run commands or pull in other files.
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
  const rc = join(dir, 'rc'), text = read(rc);
  if (text !== null) items.push({ id: '~/.ssh/rc', label: '~/.ssh/rc', path: rc, hash: sha(text) });
  const config = join(dir, 'config');
  let host = '*';
  for (const line of (read(config) ?? '').split('\n')) {
    const m = line.match(/^\s*(\w+)\s*=?\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'host' || (key === 'match' && !/\bexec\b/i.test(m[2]))) host = m[2];
    if (/^(proxycommand|localcommand|permitlocalcommand|knownhostscommand|include)$/.test(key) || (key === 'match' && /\bexec\b/i.test(m[2]))) {
      items.push({ id: `config/${host}/${m[1]}`, label: `ssh config ${host}: ${m[1]} ${m[2]}`, path: config, hash: sha(m[2]) });
    }
  }
  return items;
};
