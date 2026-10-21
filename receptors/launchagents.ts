// launchd jobs in user and system dirs; label = what the job runs.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dirs = { user: join(homedir(), 'Library/LaunchAgents'), agent: '/Library/LaunchAgents', daemon: '/Library/LaunchDaemons' };

export default () => Object.entries(dirs).flatMap(([scope, dir]) => {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.plist')); } catch {}
  return files.map((f) => {
    const path = join(dir, f);
    let hash = 'unreadable', label = f;
    try { hash = createHash('sha256').update(readFileSync(path)).digest('hex'); } catch {}
    try {
      const p = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
      label = (p.ProgramArguments ?? [p.Program]).filter(Boolean).join(' ') || p.Label || f;
    } catch {}
    return { id: `${scope}/${f.replace(/\.plist$/, '')}`, label, path, hash };
  });
});
