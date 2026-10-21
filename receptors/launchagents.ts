// launchd jobs in user and system dirs; label = what the job runs, exec = the same argv for the signing check.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dirs = { user: join(homedir(), 'Library/LaunchAgents'), agent: '/Library/LaunchAgents', daemon: '/Library/LaunchDaemons' };

// Any plist as JSON. plutil refuses JSON output when a plist holds <data> or <date>, so those become empty strings first.
// Also used by the terminal, apps and menubar receptors.
export function plist(path: string): any {
  const opts = { stdio: ['pipe', 'pipe', 'ignore'] as any };
  try { return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], opts).toString()); } catch {}
  const xml = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', path], opts).toString().replace(/<(data|date)>[\s\S]*?<\/\1>/g, '<string/>');
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { ...opts, input: xml }).toString());
}

export default () => Object.entries(dirs).flatMap(([scope, dir]) => {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.plist')); } catch {}
  return files.map((f) => {
    const path = join(dir, f);
    let hash = 'unreadable', label = f, exec: string[] | undefined;
    try { hash = createHash('sha256').update(readFileSync(path)).digest('hex'); } catch {}
    try {
      const p = plist(path), args: string[] = p.ProgramArguments ?? [];
      exec = p.Program ? [p.Program, ...args.slice(1)] : args.length ? args : undefined;
      label = (p.ProgramArguments ?? [p.Program]).filter(Boolean).join(' ') || p.Label || f;
    } catch {}
    return { id: `${scope}/${f.replace(/\.plist$/, '')}`, label, path, hash, exec };
  });
});
