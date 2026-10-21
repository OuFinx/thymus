// Codex CLI ~/.codex/config.toml: MCP servers and the notify command. Tiny line-based TOML reading.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const path = join(homedir(), '.codex/config.toml');

export default () => {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const servers: Record<string, string[]> = {};
  const items = [];
  let section = '';
  for (const line of text.split('\n')) {
    const head = line.match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*$/);
    if (head) { section = head[1]; continue; }
    const m = section.match(/^mcp_servers\.("[^"]+"|[^.]+)/);
    if (m) (servers[m[1].replace(/"/g, '')] ??= []).push(`${section}|${line}`);
    else if (!section && /^\s*notify\s*=/.test(line)) items.push({ id: 'notify', label: line.trim(), path, hash: sha(line) });
  }
  for (const [name, lines] of Object.entries(servers)) {
    const pick = (k: string) => lines.map((l) => l.split('|').slice(1).join('|')).find((l) => new RegExp(`^\\s*${k}\\s*=`).test(l))?.split('=').slice(1).join('=').trim() ?? '';
    items.push({ id: `mcp/${name}`, label: `${name}: ${pick('command') || pick('url')} ${pick('args')}`.trim(), path, hash: sha(lines.join('\n')) });
  }
  return items;
};
