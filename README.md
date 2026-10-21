# Thymus

**`npm uninstall` removed the package. It did not remove what the package left behind.**

Thymus remembers everything on your Mac that can run by itself, and tells you the moment something new shows up.

A normal day:

![thymus on a clean Mac: one line, all clear](demo/clean.gif)

The day a dependency turns out to be a worm:

![thymus after a simulated Mini Shai-Hulud infection: six numbered findings](demo/infected.gif)

## Why

The 2025-2026 npm worms (Shai-Hulud, Mini Shai-Hulud, the TanStack and keyv waves) do not stay in `node_modules`. They plant a Claude Code `SessionStart` hook, a VS Code task that runs when you open the folder, an MCP server, a LaunchAgent. Uninstalling the package leaves all of it in place, and your AI agent happily runs it next session.

Antivirus asks "does this look like known malware?". Thymus asks a simpler question: **what can run on this Mac today that could not run yesterday?** The thymus is the organ that teaches the immune system to tell self from non-self.

- **One command.** `thymus` learns your Mac on the first run and shows only what changed after that. One green line when all is fine.
- **18 receptors**: LaunchAgents and Daemons, Claude Code hooks, MCP servers (Claude, Cursor, VS Code, Gemini, Codex), VS Code `folderOpen` tasks and scripts dropped into `.claude/` and `.vscode/` of every repo, git hooks, shell startup files, ssh, browser and editor extensions, Hammerspoon, menu bar plugins, terminal profiles and more.
- **Who signed it.** Every program is checked with `codesign`: unsigned binaries, missing binaries and scripts in writable folders are red, Apple and trusted vendors fade out.
- **Known-bad indicators.** A Shai-Hulud pack (file names, SHA-256, launchd labels) built from published advisories, each with its source link.
- **`thymus check`** looks up every lockfile on your disk in the [OpenSSF malicious packages](https://github.com/ossf/malicious-packages) database via osv.dev.
- **Read-only, zero dependencies, no daemon, no telemetry.** It never deletes or edits anything, and never stores secret values.
- **Plugins in any language.** A receptor is any executable that prints JSON, an indicator pack is a JSON file.

## Quickstart

Needs macOS and Node 23.6+ (runs TypeScript directly). No dependencies.

```sh
git clone https://github.com/OuFinx/thymus && cd thymus
./bin/thymus                  # first run: learns this Mac into ~/.thymus
./bin/thymus                  # later: what is new? exit code 1 if anything
./bin/thymus explain 2        # what is item 2, what runs it, who signed it
./bin/thymus approve 2        # it is mine (or --all)
./bin/thymus check            # lockfiles vs known malicious package versions (network)
./bin/thymus schedule install # run daily, notify only when something is new
```

Other commands: `thymus list [--suspicious]`, `thymus receptors`, `--json` on `diff` and `check`, `-v` for the detailed view. Daily run details: [docs/launchd.md](docs/launchd.md).

Try it without touching your Mac: `bash`, then `source demo/demo.sh`, `thymus`, `npm install @demo/colors` (a fake npm that plants inert worm files in a throwaway HOME), `thymus`, `exit`. The GIFs are recorded that way with `vhs demo/clean.tape` and `vhs demo/infected.tape`.

**If it is Shai-Hulud:** unload its LaunchAgent first (`launchctl bootout gui/$(id -u)/com.user.gh-token-monitor`), only then revoke GitHub and npm tokens. Its handler is reported to run `rm -rf ~/` when the token stops working ([Wiz](https://www.wiz.io/blog/mini-shai-hulud-strikes-again-tanstack-more-npm-packages-compromised), [JFrog](https://research.jfrog.com/post/shai-hulud-here-we-go-again/), [Intrudify](https://github.com/Intrudify/mini-shai-hulud-scanner)).

## Who signed it

For every item that runs a program (LaunchAgents and Daemons, MCP servers, Dock and re-opened apps, plugin bundles) Thymus reads the code signature with `codesign -dv --verbose=2` and shows it next to the item:

| Shown as | Meaning | Marked |
|---|---|---|
| `(Apple)` | part of macOS | line dimmed |
| `(Developer ID BJ4HAAB9B3)`, `(App Store ...)` | signed by the vendor with that Apple Team ID | |
| `[SUSPICIOUS: unsigned]`, `[SUSPICIOUS: ad-hoc signed]` | nobody vouches for this binary | red |
| `[SUSPICIOUS: binary missing]` | the job points at a file that is not there (stale, or waiting for a payload) | red |
| `[SUSPICIOUS: script in a writable folder]` | `node`, `python`, `bash`, `osascript`... running a file in your home or a temp dir, which anything you run can rewrite | red |
| `(downloads a package at run time)` | `npx`, `uvx`, `bunx`: the code is fetched from a registry when it starts | |

Verdicts are cached by path and modification time in `~/.thymus/codesign-cache.json`, so a warm run stays fast. The signature is not part of the item hash, so it never causes a "changed" by itself. Thymus does not run `spctl --assess`: it can wait about 15 s on a network notarization check. Homebrew binaries are ad-hoc signed on Apple Silicon, so their agents show as suspicious unless a card trusts them (the default `homebrew.mxcl.*` card does).

## Known-bad (antibodies)

`antibodies/*.json` are indicator packs: file names, SHA-256 hashes and launchd labels copied from published advisories, each with its source URL. Every run (`thymus`, `diff`, `check`) matches them against everything the receptors see, baselined or not, and prints `KNOWN-BAD` at the top with exit code 1. The shipped pack covers the Shai-Hulud family (2025 waves, Mini Shai-Hulud, the keyv / ChainDrop wave from [CSA Singapore AD-2026-009](https://www.csa.gov.sg/alerts-and-advisories/advisories/ad-2026-009)). Packs are plugins: drop your own JSON in `~/.thymus/antibodies/`.

```json
{
  "name": "my-pack",
  "advice": "printed once when anything in this pack matches",
  "iocs": [
    { "file": "setup_bun.js", "note": "what it is", "url": "https://source" },
    { "file": "*/.github/workflows/formatter_*.yml", "url": "..." },
    { "sha256": "64 hex chars", "url": "..." },
    { "label": "*gh-token-monitor*", "url": "..." }
  ]
}
```

`file` is a glob on the file name, or on the full path when it contains a `/`. It is matched against each item's file and the program or script it runs. `sha256` is compared with the content of those files. `label` is a glob on `receptor:id` and the label. Globs are case-insensitive with `*` only.

## thymus check: malicious package versions

`thymus check` collects name and version from the lockfiles in your repos (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `poetry.lock`, `uv.lock`, `requirements.txt`) and from `npm ls -g`, and looks them up in [osv.dev](https://osv.dev) with one `querybatch` call per 1000 packages. Only `MAL-` advisories count ([OpenSSF malicious packages](https://github.com/ossf/malicious-packages)), ordinary CVEs are ignored. It also sweeps repo folders, `.github/workflows` and the top of every installed package for IOC file names such as `bun_environment.js`. Exit code 1 on any hit, each one with package, version, lockfile and the osv.dev link.

This sends package names and versions to osv.dev (Google), which is why it is a separate command and never part of `diff`. Keep internal packages out with `~/.thymus/config.json`: `{"private": ["@mycorp/*", "internal-*"]}`. `--no-global` skips `npm ls -g`. Answers are cached for a day in `~/.thymus/osv-cache.json`.

## Read-only by design

Thymus writes only inside `~/.thymus` (or `$THYMUS_HOME`): the baseline, `known.json` and two caches. It never deletes, unloads or edits anything it finds. Snapshots store hashes and short labels, never file contents: secret-looking values (npm tokens, MCP `env`, `token=...`) are hashed or masked.

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

Pin the `label` (what the job runs) whenever you can: an id alone is easy to imitate. A card can also trust a code-signing vendor by Apple Team ID, for any item whose program that vendor signed:

```json
[{ "team": "BJ4HAAB9B3" }, { "receptor": "launchagents", "team": "EQHXZ8M8AV" }]
```

Find a Team ID with `codesign -dv --verbose=2 /Applications/zoom.us.app 2>&1 | grep TeamIdentifier`, or `thymus explain <id>`. `thymus init` copies a small default list from `known.default.json`, including Team IDs of Microsoft, Google, Docker, Tailscale, Objective-See, 1Password and Slack. Each of those has a `source` link to the vendor's own docs or code where the ID appears; vendors whose ID could not be confirmed that way (Zoom, Anthropic, Cursor among them) are left out, add them yourself if you use them.

## Surfaces

| Receptor | What it watches |
|---|---|
| launchagents | `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons` (plist hash, label = program) |
| crontab | each active line of `crontab -l` |
| shellrc | zsh, bash, fish startup files in `$HOME` and `/etc` |
| ssh | `authorized_keys` (one item per key fingerprint), `~/.ssh/rc`, `~/.ssh/config` `ProxyCommand`, `LocalCommand`, `KnownHostsCommand`, `Match exec`, `Include` |
| browsers | Chrome, Brave, Arc, Edge, Chromium, Vivaldi extensions per profile |
| git | global git hooks (`core.hooksPath`, template dirs) and git config keys that run commands |
| editors | VS Code, Insiders, Cursor, Windsurf extensions and user-level `tasks.json` |
| claude | Claude Code user hooks, statusLine, credential helpers, enabled plugins |
| mcp | MCP servers in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI |
| codex | Codex `config.toml` MCP servers and `notify` |
| npmrc | `~/.npmrc` keys (secret values hidden) |
| hammerspoon | `~/.hammerspoon` Lua files, Spoons, a moved config (`MJConfigFile`) |
| menubar | xbar, BitBar and SwiftBar plugin scripts (dirs read from each app's preferences) |
| terminal | Terminal.app profile `CommandString` / `Shell`, iTerm2 profile commands and AutoLaunch scripts, Ghostty `command` / `initial-command` |
| apps | Dock pinned apps and apps re-opened at login (signing checked) |
| plugins | preference panes, screen savers, color pickers, QuickLook and Spotlight plugins (user and `/Library`), folder action scripts |
| legacy | your `at` jobs, periodic scripts, emond rules, StartupItems, only where present |
| projects | inside your repos: `.claude/settings*.json` hooks, `.vscode/tasks.json` folderOpen tasks, scripts dropped in `.claude/` or `.vscode/`, `.mcp.json` and other project MCP configs, `.cursor/hooks.json`, exec-capable `.vscode/settings.json` keys, `.git/hooks` |

The projects receptor walks `~/Work`, `~/Projects`, `~/code`, `~/src`, `~/dev`, `~/Developer`, `~/repos`, `~/git`, `~/GitHub` (whichever exist, 5 levels deep, skipping `node_modules`, `vendor`, build dirs). It never touches `~/Documents`, `~/Desktop`, `~/Downloads` or `~/Library` unless you ask, since macOS would show a privacy prompt. Your own roots: `~/.thymus/config.json` with `{"roots": ["~/Documents/code"]}`.

Full list of known persistence surfaces with sources, including what is not covered yet: [docs/surfaces.md](docs/surfaces.md).

## Tests

```sh
npm test   # node --test with a fake HOME per test
```
