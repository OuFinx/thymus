# Surfaces

Places where code can get itself executed on a developer's Mac without anyone running it on purpose. "Receptor" names the built-in receptor that covers it; "-" means not covered yet.

## macOS persistence

| Surface | Location | Reference | Receptor |
|---|---|---|---|
| Launch Agents | `~/Library/LaunchAgents`, `/Library/LaunchAgents` | [MITRE T1543.001](https://attack.mitre.org/techniques/T1543/001/) | launchagents |
| Launch Daemons | `/Library/LaunchDaemons` | [MITRE T1543.004](https://attack.mitre.org/techniques/T1543/004/) | launchagents |
| Plist modification of existing jobs | any launchd plist | [MITRE T1547.011](https://attack.mitre.org/techniques/T1547/011/) | launchagents (content hash) |
| Cron | `crontab -l` | [MITRE T1053.003](https://attack.mitre.org/techniques/T1053/003/) | crontab |
| Periodic scripts | `/etc/periodic/*`, `/usr/local/etc/periodic`, `/etc/periodic.conf*` | [Objective-See, Art of Mac Malware ch. 2](https://nostarch.com/download/samples/501942c02_samplechapter.pdf) | - (periodic(8) is gone in macOS 26) |
| Shell startup files | `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, fish config, `/etc/zshrc` etc. | [MITRE T1546.004](https://attack.mitre.org/techniques/T1546/004/) | shellrc |
| SSH authorized keys, `~/.ssh/rc`, `~/.ssh/config` (ProxyCommand, LocalCommand) | `~/.ssh` | [MITRE T1098.004](https://attack.mitre.org/techniques/T1098/004/) | ssh |
| Browser extensions | Chrome, Brave, Arc, Edge, Chromium, Vivaldi profiles | [MITRE T1176](https://attack.mitre.org/techniques/T1176/) | browsers |
| Login items / Background Task Management | BTM database (root only, `sfltool dumpbtm` needs sudo) | [MITRE T1547.015](https://attack.mitre.org/techniques/T1547/015/) | - (needs root or an Automation prompt) |
| Login / logout hooks | `com.apple.loginwindow` LoginHook (deprecated) | [MITRE T1037.002](https://attack.mitre.org/techniques/T1037/002/) | - |
| Startup items | `/Library/StartupItems` (legacy) | [MITRE T1037.005](https://attack.mitre.org/techniques/T1037/005/) | - |
| Emond | `/etc/emond.d` (removed in Ventura) | [MITRE T1546.014](https://attack.mitre.org/techniques/T1546/014/) | - |
| Re-opened applications | `~/Library/Preferences/ByHost/com.apple.loginwindow.*` | [MITRE T1547.007](https://attack.mitre.org/techniques/T1547/007/) | - |
| Dylib injection / hijack | `DYLD_INSERT_LIBRARIES` in plists and app bundles | [MITRE T1574.006](https://attack.mitre.org/techniques/T1574/006/) | partial (launchd plist hash) |
| Kernel / system extensions, authorization plugins, Spotlight importers, folder actions | various | [Objective-See KnockKnock](https://objective-see.org/products/knockknock.html), [Kandji: Mac malware persistence](https://blog.kandji.io/mac-malware-persistence) | - |

## Dev-tool autorun surfaces

| Surface | Location | Reference | Receptor |
|---|---|---|---|
| Claude Code hooks (SessionStart etc.), statusLine, apiKeyHelper, enabled plugins | `~/.claude/settings.json`, `~/.claude/settings.local.json`, managed settings | [Sonar: Mini Shai-Hulud targets AI coding agents](https://www.sonarsource.com/zh/blog/mini-shai-hulud-targets-ai-coding-agents/), [Securonix detection](https://connect.securonix.com/threat-research-intelligence-62/beta-detection-mini-shai-hulud-claude-code-or-vs-code-persistence-hook-injection-analytic-311) | claude |
| Project-level `.claude/settings.json` SessionStart hook (`matcher: "*"`, `node .vscode/setup.mjs`), also `settings.local.json`, statusLine, apiKeyHelper, `enableAllProjectMcpServers` | inside every repo | [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-shai-hulud-ai-supply-chain-20260517-csa-st/), [Backslash](https://www.backslash.security/blog/shai-huluds-new-frontier), [WorkOS](https://workos.com/blog/npm-worm-coding-agent-config-credentials) | projects |
| VS Code tasks with `runOptions.runOn: folderOpen` (task "Environment Setup" running `node .claude/setup.mjs`) | project `.vscode/tasks.json`; user `~/Library/Application Support/<editor>/User/tasks.json` | [Sonar](https://www.sonarsource.com/blog/mini-shai-hulud-targets-ai-coding-agents/), [WorkOS](https://workos.com/blog/npm-worm-coding-agent-config-credentials) | projects (folderOpen tasks only), editors (user file) |
| Dropped payloads the hooks call: `.claude/setup.mjs`, `.vscode/setup.mjs`, `.claude/router_runtime.js` (Bun payload copy) | inside every repo | [Securonix deobfuscated persistence map](https://connect.securonix.com/threat-research-intelligence-62/beta-detection-mini-shai-hulud-claude-code-or-vs-code-persistence-hook-injection-analytic-311) | projects (any `.js/.mjs/.cjs/.ts/.sh/.py` directly in `.claude/` or `.vscode/`) |
| Project MCP servers | `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json` | [WorkOS](https://workos.com/blog/npm-worm-coding-agent-config-credentials) | projects |
| Cursor project hooks (`sessionStart`, `workspaceOpen`, ...) | `.cursor/hooks.json` | [Cursor hooks docs](https://cursor.com/docs/agent/hooks) | projects |
| VS Code workspace settings that point at a binary or turn off prompts (`*.executablePath`, `*.path`, `terminal.integrated.env/profiles`, `task.allowAutomaticTasks`, `chat.permissions.default: autoApprove`) | `.vscode/settings.json` | [VS Code RCE via workspace settings](https://blog.ammaraskar.com/vscode-rce/), [Repello: Copilot autoApprove from repo settings](https://repello.ai/blog/vscode-copilot-workspace-trust-bypass) | projects |
| Repo git hooks and `core.hooksPath` / `core.fsmonitor` | `.git/hooks/*` (executable, non-sample), `.git/config` | [git-config docs](https://git-scm.com/docs/git-config) | projects |
| Worm CI workflows (`.github/workflows/discussion.yaml`, `shai-hulud-workflow.yml`, `codeql_analysis.yml`, `format-check.yml`) and `package.json` `prepare`/`optionalDependencies` injection | inside repos, pushed to GitHub | [CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-shai-hulud-ai-supply-chain-20260517-csa-st/), [Intrudify scanner IOC list](https://github.com/Intrudify/mini-shai-hulud-scanner) | - (runs in CI or on install, not on open; every legit CI edit would alert) |
| Python `.pth` startup file (`litellm_init.pth`), `gh-token-monitor` daemon (wipes `~` if its token is revoked: disable it before rotating) | site-packages; LaunchAgent on macOS | [Intrudify](https://github.com/Intrudify/mini-shai-hulud-scanner), [CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-shai-hulud-ai-supply-chain-20260517-csa-st/) | launchagents (daemon); `.pth` not covered |
| VS Code / Cursor / Windsurf extensions | `~/.vscode/extensions`, `~/.cursor/extensions`, `~/.windsurf/extensions` | [Stork: your code editor is the new trojan horse](https://www.stork.ai/blog/es/your-code-editor-is-the-new-trojan-horse) | editors |
| MCP servers | `~/.claude.json`, `~/.cursor/mcp.json`, Windsurf, Claude Desktop, VS Code `mcp.json`, Gemini CLI | [WorkOS](https://workos.com/blog/npm-worm-coding-agent-config-credentials), [snyk/agent-scan](https://github.com/snyk/agent-scan) | mcp |
| Codex MCP servers and `notify` command | `~/.codex/config.toml` | [Codex config docs](https://github.com/openai/codex/blob/main/docs/config.md) | codex |
| Git hooks and exec-capable git config (core.hooksPath, core.fsmonitor, sshCommand, credential helpers, `!` aliases, filters, textconv, includes) | `~/.gitconfig`, `~/.config/git/config`, template dirs | [git-config docs](https://git-scm.com/docs/git-config) | git |
| npm config (`node-options`, `script-shell`, `ignore-scripts`, registry, tokens) | `~/.npmrc` | [npm-config docs](https://docs.npmjs.com/cli/using-npm/config) | npmrc |
| Self-hosted GitHub Actions runner as backdoor (runner named SHA1HULUD) | runner install dir, launchd service if installed as service | [Cycode: Shai-Hulud second coming](https://cycode.com/blog/shai-hulud-second-coming-supply-chain-attack/), [Sysdig](https://www.sysdig.com/blog/how-threat-actors-are-using-self-hosted-github-actions-runners-as-backdoors) | partial (launchagents, when installed as a service) |
| Stolen tokens reused after cleanup | GitHub PATs, cloud creds | [Security Boulevard: Shai-Hulud the second coming](https://securityboulevard.com/2025/11/shai-hulud-the-second-coming/) | - (not persistence; rotate tokens) |

## Prior art

- [KnockKnock](https://objective-see.org/products/knockknock.html) (Objective-See, ~0.8k stars): enumerates macOS persistence, no baseline diff, no dev-tool surfaces.
- [BlockBlock](https://objective-see.org/products/blockblock.html) (~0.9k stars): real-time alerts on new launchd items, needs Full Disk Access, no dev-tool surfaces.
- [osquery](https://github.com/osquery/osquery) (~24k stars): has `launchd`, `crontab`, browser extension tables and differential scheduled queries, but no Claude/MCP/Codex/git-hook tables out of the box and it is a heavy agent.
- [Santa](https://github.com/northpolesec/santa): binary allow-listing, different layer.
- [cc-audit](https://github.com/ryo-ebata/cc-audit) (26 stars), [snyk/agent-scan](https://github.com/snyk/agent-scan) (~3k stars), [cisco mcp-scanner](https://github.com/cisco-ai-defense/mcp-scanner) (~1k stars): scan agent/MCP configs for known-bad patterns, not a baseline of every persistence surface.
- Shai-Hulud detectors ([Cobenian/shai-hulud-detect](https://github.com/Cobenian/shai-hulud-detect), [thumper](https://github.com/jestasecurity/thumper)): IOC lists for one campaign, they miss the next one.
- [MacPersistenceChecker](https://github.com/Pinperepette/MacPersistenceChecker) (~0.3k stars): persistence scanner with timeline, no dev-tool surfaces.

None of them baselines dev-tool and OS persistence surfaces together with plugins, which is the gap Thymus fills.
