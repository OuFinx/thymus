// User-level MCP servers across AI tools. Hash covers the whole server config, label never shows env.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const h = homedir(), support = join(h, 'Library/Application Support');
const sources: [string, string, string][] = [
  ['claude-code', join(h, '.claude.json'), 'mcpServers'],
  ['claude-desktop', join(support, 'Claude/claude_desktop_config.json'), 'mcpServers'],
  ['cursor', join(h, '.cursor/mcp.json'), 'mcpServers'],
  ['windsurf', join(h, '.codeium/windsurf/mcp_config.json'), 'mcpServers'],
  ['vscode', join(support, 'Code/User/mcp.json'), 'servers'],
  ['gemini', join(h, '.gemini/settings.json'), 'mcpServers'],
];

export default () => {
  const items = [];
  for (const [tool, path, key] of sources) {
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); } catch { continue; }
    let servers: Record<string, any>;
    try { servers = JSON.parse(raw)[key] ?? {}; } catch {
      items.push({ id: `${tool}/(unparsed)`, label: `${tool}: file is not plain JSON, tracking whole file`, path, hash: sha(raw) });
      continue;
    }
    for (const [name, cfg] of Object.entries(servers)) {
      const label = cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ');
      items.push({ id: `${tool}/${name}`, label: `${name}: ${label}`, path, hash: sha(JSON.stringify(cfg)) });
    }
  }
  return items;
};
