// thymus check: package versions from lockfiles and global npm, looked up in osv.dev for malicious-package (MAL-) advisories.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { jsonc } from './receptors/projects.ts';

export type Pkg = { eco: 'npm' | 'PyPI'; name: string; version: string; where: string };
export const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'poetry.lock', 'uv.lock', 'requirements.txt']);

export function lockfile(where: string, text: string): Pkg[] {
  const out: Pkg[] = [];
  const add = (eco: Pkg['eco'], name?: string, version?: string) => name && version && /^\d/.test(version) && out.push({ eco, name, version, where });
  const at = (spec: string) => [spec.slice(0, spec.indexOf('@', 1)), spec.slice(spec.indexOf('@', 1) + 1)];
  switch (basename(where)) {
    case 'package-lock.json': case 'npm-shrinkwrap.json': {
      const j = JSON.parse(text);
      for (const [k, v] of Object.entries<any>(j.packages ?? {})) if (k) add('npm', v.name ?? k.split('node_modules/').pop(), v.version);
      const v1 = (deps: any) => { for (const [n, v] of Object.entries<any>(deps ?? {})) { add('npm', n, v.version); v1(v.dependencies); } };
      if (!j.packages) v1(j.dependencies);
      break;
    }
    // v5 "/name/1.0.0:", v6 "/name@1.0.0:", v9 "name@1.0.0:"; peer suffixes like (react@18) or _react@18 are cut.
    case 'pnpm-lock.yaml':
      for (const [, n, v] of text.matchAll(/^ {2}['"]?\/?((?:@[^/'"\s]+\/)?[^@/'"\s(]+)[@/](\d[^:('"\s_]*)/gm)) add('npm', n, v);
      break;
    // Classic `version "1.0.0"` and berry `version: 1.0.0`, name from the first spec in the block header.
    case 'yarn.lock':
      for (const block of text.split(/\n\s*\n/)) {
        const head = block.split('\n').find((l) => /^[^\s#]/.test(l)), v = block.match(/^ {2}version:? "?([^"\n]+)"?$/m)?.[1];
        const spec = head?.split(',')[0].replace(/[":]/g, '').trim() ?? '';
        if (!spec.includes('@workspace') && spec !== '__metadata') add('npm', at(spec.replace('@npm', ''))[0], v);
      }
      break;
    case 'bun.lock':
      for (const v of Object.values<any>(jsonc(text).packages ?? {})) if (typeof v?.[0] === 'string') add('npm', ...at(v[0]));
      break;
    case 'poetry.lock': case 'uv.lock':
      for (const [, n, v] of text.matchAll(/^\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/gm)) add('PyPI', n, v);
      break;
    case 'requirements.txt':
      for (const [, n, v] of text.matchAll(/^([A-Za-z0-9._-]+)\s*==\s*([^\s;#]+)/gm)) add('PyPI', n, v);
  }
  return out;
}

export function globalNpm(): Pkg[] {
  let tree: any;
  try { tree = JSON.parse(execFileSync('npm', ['ls', '-g', '--json', '--all'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, maxBuffer: 64 << 20 }).toString()); } catch (e: any) {
    try { tree = JSON.parse(e.stdout?.toString() ?? ''); } catch { return []; }
  }
  const out: Pkg[] = [];
  const visit = (deps: any) => { for (const [name, d] of Object.entries<any>(deps ?? {})) { if (d.version) out.push({ eco: 'npm', name, version: d.version, where: 'npm -g' }); visit(d.dependencies); } };
  visit(tree?.dependencies);
  return out;
}

// One querybatch call per 1000 packages (the API limit), sent in parallel; results cached for a day per name@version.
export async function malicious(pkgs: Pkg[], cacheFile: string, url = process.env.THYMUS_OSV_URL || 'https://api.osv.dev/v1/querybatch') {
  const key = (p: Pkg) => `${p.eco}:${p.name}@${p.version}`;
  const cache: Record<string, { ids: string[]; at: number }> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  const fresh = (k: string) => cache[k] && Date.now() - cache[k].at < 86_400_000;
  const todo = [...new Map(pkgs.filter((p) => !fresh(key(p))).map((p) => [key(p), p])).values()];
  const batches = Array.from({ length: Math.ceil(todo.length / 1000) }, (_, i) => todo.slice(i * 1000, i * 1000 + 1000));
  await Promise.all(batches.map(async (batch) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: batch.map((p) => ({ package: { name: p.name, ecosystem: p.eco }, version: p.version })) }) });
    if (!res.ok) throw new Error(`osv.dev answered ${res.status}`);
    // ponytail: next_page_token ignored, it only appears for packages with very many advisories and MAL ids come first in practice.
    const { results } = await res.json() as { results: { vulns?: { id: string }[] }[] };
    batch.forEach((p, j) => { cache[key(p)] = { ids: (results[j]?.vulns ?? []).map((v) => v.id).filter((id) => id.startsWith('MAL-')), at: Date.now() }; });
  }));
  writeFileSync(cacheFile, JSON.stringify(cache));
  return pkgs.filter((p) => cache[key(p)]?.ids.length).map((p) => ({ ...p, ids: cache[key(p)].ids }));
}
