# Thymus

Learns what "self" looks like on your Mac (every place code can quietly get itself run) and tells you only what is new since then.

The thymus is the organ that teaches the immune system to tell self from non-self. 2025-2026 npm worms (Shai-Hulud and successors) persist through Claude Code hooks, VS Code tasks, MCP configs, git hooks and LaunchAgents, and `npm uninstall` removes none of it. Thymus does not know what malware looks like. It knows what your machine looked like yesterday.

## 30-second quickstart

Needs Node 23.6+ (runs TypeScript directly), no dependencies.

```sh
git clone <this repo> thymus && cd thymus
./bin/thymus init        # baseline into ~/.thymus/self.json
./bin/thymus diff        # later: what is new or changed? exit 1 if anything
./bin/thymus approve launchagents:user/com.example.agent   # or --all
```

Other commands: `thymus list` (the baseline), `thymus receptors` (receptors, item counts, errors), `thymus diff --json`. To run it daily with a notification see [docs/launchd.md](docs/launchd.md).

## Sample output

```
$ thymus diff
thymus: 2 new, 1 changed, 0 removed since 2026-10-20 10:00

claude
  + claude:settings.json:hook/SessionStart/*/node .claude/setup.mjs  SessionStart hook: node .claude/setup.mjs
      /Users/me/.claude/settings.json

launchagents
  + launchagents:user/com.apple.updater  /Users/me/.local/share/.u/node /Users/me/.local/share/.u/index.js
      /Users/me/Library/LaunchAgents/com.apple.updater.plist

shellrc
  ~ shellrc:~/.zshrc
      /Users/me/.zshrc

Known and wanted?  thymus approve <receptor:id> ...   (or --all)
Not sure?  look at the file (cat, plutil -p), check where it came from (ls -l@ <path>; mdls -n kMDItemWhereFroms <path>), search the label online. Thymus never deletes anything: remove it by hand, then approve the removal.
```

`+` new, `~` changed (content hash differs), `-` removed. Removed items are shown but do not make the exit code 1.

## Read-only by design

Thymus writes only inside `~/.thymus` (or `$THYMUS_HOME`). It never deletes, unloads or edits anything it finds. Snapshots store hashes and short labels, never file contents: secret-looking values (npm tokens, MCP `env`, `token=...`) are hashed or masked.

## Receptors

A receptor is one executable file that prints a JSON array to stdout:

```json
[{ "id": "unique-within-receptor", "label": "what a human should see", "path": "/optional/file", "hash": "anything that changes when the thing changes" }]
```

Built-in receptors live in `receptors/`, yours go in `~/.thymus/receptors/` (same name overrides a built-in). Any language works as long as the file is executable. A `.ts` file that does `export default async () => items` works too. A receptor that crashes, times out (30 s) or prints bad JSON is reported as an error and the rest of the run goes on.

A complete receptor in bash, tracking files in `~/bin`:

```bash
#!/bin/bash
# ~/.thymus/receptors/home-bin.sh: every executable in ~/bin, hashed.
items=""
for p in "$HOME"/bin/*; do
  [ -f "$p" ] && [ -x "$p" ] || continue
  hash=$(shasum -a 256 < "$p" | cut -c1-64)
  name=$(basename "$p")
  items="$items${items:+,}{\"id\":\"$name\",\"label\":\"~/bin/$name\",\"path\":\"$p\",\"hash\":\"$hash\"}"
done
echo "[$items]"
```

`chmod +x` it, then `thymus diff` shows its items as new; `thymus approve --all` adopts them. Receptors read `$HOME`, so tests can point them at a fake home.

## Self-antigen cards

`~/.thymus/known.json` pre-approves common legit items so they never show up. Each card is a set of case-insensitive globs (`*` only) and all given fields must match:

```json
[{ "receptor": "launchagents", "id": "*/com.docker.*", "label": "*docker*" }]
```

Pin the `label` (what the job runs) whenever you can: an id alone is easy to imitate. `thymus init` copies a small default list from `known.default.json`.

## Surfaces

| Receptor | What it watches |
|---|---|
| launchagents | `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons` (plist hash, label = program) |
| crontab | each active line of `crontab -l` |
| shellrc | zsh, bash, fish startup files in `$HOME` and `/etc` |
| ssh | `authorized_keys` (one item per key fingerprint), `~/.ssh/rc`, `~/.ssh/config` |
| browsers | Chrome, Brave, Arc, Edge, Chromium, Vivaldi extensions per profile |
| git | global git hooks (`core.hooksPath`, template dirs) and git config keys that run commands |
| editors | VS Code, Insiders, Cursor, Windsurf extensions and user-level `tasks.json` |
| claude | Claude Code user hooks, statusLine, credential helpers, enabled plugins |
| mcp | MCP servers in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI |
| codex | Codex `config.toml` MCP servers and `notify` |
| npmrc | `~/.npmrc` keys (secret values hidden) |

Full list of known persistence surfaces with sources, including what is not covered yet: [docs/surfaces.md](docs/surfaces.md).

## Tests

```sh
npm test   # node --test with a fake HOME per test
```
