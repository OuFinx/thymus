// Old scheduled and boot mechanisms, only where present: your at jobs (atq), periodic scripts, emond rules, StartupItems.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const ls = (d: string) => { try { return readdirSync(d).filter((e) => !e.startsWith('.')).sort().map((e) => join(d, e)); } catch { return []; } };
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).toString();

export default () => {
  const items = [];
  // atq lists only your own jobs and needs no root; at -c prints the whole job (environment included), so it is only hashed.
  if (existsSync('/usr/bin/atq')) {
    try {
      for (const [, n] of sh('atq', []).matchAll(/^(\d+)\s/gm)) {
        const job = sh('at', ['-c', n]);
        items.push({ id: `at/${n}`, label: `at job ${n}: ${job.trim().split('\n').pop()}`, hash: sha(job) });
      }
    } catch {}
  }
  const files = [
    '/etc/periodic.conf', '/etc/periodic.conf.local', '/etc/daily.local', '/etc/weekly.local', '/etc/monthly.local',
    ...['/etc/periodic', '/usr/local/etc/periodic'].flatMap((d) => ls(d).flatMap(ls)),
    ...ls('/etc/emond.d/rules'), ...ls('/private/var/db/emondClients'), ...ls('/Library/StartupItems'),
  ];
  for (const path of files) {
    try {
      if (!statSync(path).isFile() && !path.startsWith('/Library/StartupItems')) continue;
      const hash = statSync(path).isFile() ? sha(readFileSync(path)) : sha(ls(path).join('\n'));
      items.push({ id: path, label: path, path, hash });
    } catch {}
  }
  return items;
};
