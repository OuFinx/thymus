// ~/.npmrc keys. Values of secret-looking keys are never printed, only hashed.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const path = join(homedir(), '.npmrc');
const secret = /auth|token|pass|key|cert|secret|email|_/i;

export default () => {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !/^[#;]/.test(l)).map((line) => {
    const i = line.indexOf('='), key = (i < 0 ? line : line.slice(0, i)).trim(), value = i < 0 ? '' : line.slice(i + 1).trim();
    return { id: key, label: secret.test(key) ? `${key}=<hidden>` : `${key}=${value}`, path, hash: sha(line) };
  });
};
