// Global git hooks and git config keys that can run commands.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const home = homedir();
const exec = /^(core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy)|credential\..*helper|filter\..*\.(clean|smudge|process)|diff\..*\.(textconv|command)|merge\..*\.driver|gpg\..*program|sequence\.editor|init\.templatedir|include\.path|includeif\..*\.path|uploadpack\.packobjectshook|pager\..*)$/;

export default () => {
  const items = [];
  const config: Record<string, string> = {};
  // Only call git when a global config exists: on a Mac without CLT, /usr/bin/git pops an install dialog.
  if (existsSync(join(home, '.gitconfig')) || existsSync(join(home, '.config/git/config'))) {
    const out = execFileSync('git', ['config', '--global', '--list'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    for (const line of out.split('\n')) {
      const i = line.indexOf('='), key = line.slice(0, i).toLowerCase(), value = line.slice(i + 1);
      if (i < 1 || !(exec.test(key) || (key.startsWith('alias.') && value.startsWith('!')))) continue;
      config[key] = value;
      items.push({ id: `config/${key}`, label: `${key}=${value}`, hash: sha(value) });
    }
  }
  const tilde = (p?: string) => p?.replace(/^~(?=\/|$)/, home);
  const hookDirs = new Set([tilde(config['core.hookspath']), join(tilde(config['init.templatedir']) ?? '', 'hooks'), join(home, '.git-templates/hooks'), join(home, '.git_template/hooks')]);
  for (const dir of hookDirs) {
    if (!dir || dir === 'hooks') continue;
    let files: string[] = [];
    try { files = readdirSync(dir); } catch {}
    for (const f of files) {
      const path = join(dir, f);
      if (f.endsWith('.sample') || !statSync(path).isFile()) continue;
      items.push({ id: `hook/${path.replace(home, '~')}`, label: path.replace(home, '~'), path, hash: sha(readFileSync(path)) });
    }
  }
  return items;
};
