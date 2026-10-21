// Claude Code user settings: hooks, statusLine, credential helpers, enabled plugins.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const files = [join(homedir(), '.claude/settings.json'), join(homedir(), '.claude/settings.local.json'), '/Library/Application Support/ClaudeCode/managed-settings.json'];
const helpers = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];

// Also used by the projects receptor for <repo>/.claude/settings*.json.
export function settingsItems(path: string, prefix: string) {
  const items = [];
  let s: any;
  try { s = JSON.parse(readFileSync(path, 'utf8')); } catch { return items; }
  const add = (id: string, label: string, v: unknown) => items.push({ id: `${prefix}:${id}`, label, path, hash: sha(JSON.stringify(v)) });
  for (const [event, groups] of Object.entries<any[]>(s.hooks ?? {})) {
    for (const g of groups ?? []) for (const h of g.hooks ?? []) {
      const what = h.command ?? h.url ?? h.prompt ?? h.type;
      add(`hook/${event}/${g.matcher || '*'}/${what}`, `${event} hook: ${what}`, h);
    }
  }
  if (s.statusLine?.command) add('statusLine', `statusLine: ${s.statusLine.command}`, s.statusLine);
  for (const k of helpers) if (s[k]) add(k, `${k}: ${s[k]}`, s[k]);
  for (const [p, on] of Object.entries(s.enabledPlugins ?? {})) if (on) add(`plugin/${p}`, `plugin ${p}`, p);
  if (s.enableAllProjectMcpServers) add('enableAllProjectMcpServers', 'enableAllProjectMcpServers: every .mcp.json server starts without asking', true);
  return items;
}

export default () => files.flatMap((p) => settingsItems(p, basename(p)));
