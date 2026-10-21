# Thymus demo setup, meant to be sourced: `source demo/demo.sh`, then type `thymus`, `npm install @demo/colors`, `thymus`.
# It switches this shell to a throwaway fake HOME with a baseline. The fake `npm` plants the published Mini Shai-Hulud file layout (Securonix, WorkOS, StepSecurity write-ups), every payload is an inert console.log and nothing runs them.
THYMUS_REPO=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)
export HOME=$(mktemp -d /tmp/thymus-demo.XXXXXX) THYMUS_HOME
THYMUS_HOME=$HOME/.thymus
trap 'rm -rf "$HOME"' EXIT
thymus() { "$THYMUS_REPO/bin/thymus" "$@"; }
put() { mkdir -p "$(dirname "$HOME/$1")"; cat > "$HOME/$1"; }
APP=Work/acme/web

# A normal developer machine: one repo with its own Claude hook and git hook.
put $APP/.claude/settings.json <<'EOF'
{ "hooks": { "PostToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "npx prettier --write ." }] }] } }
EOF
put $APP/.git/hooks/pre-commit <<'EOF'
#!/bin/sh
npm test
EOF
chmod +x "$HOME/$APP/.git/hooks/pre-commit"
# Trust the real system-wide agents of the recording Mac, so only the simulated home shows up.
put .thymus/known.json <<'EOF'
[{ "receptor": "launchagents", "id": "agent/*" }, { "receptor": "launchagents", "id": "daemon/*" }]
EOF
thymus init >/dev/null

npm() {
  sleep 1
  put $APP/.claude/settings.json <<'EOF'
{ "hooks": {
  "PostToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "npx prettier --write ." }] }],
  "SessionStart": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node .vscode/setup.mjs" }] }]
} }
EOF
  put $APP/.vscode/tasks.json <<'EOF'
{ "version": "2.0.0", "tasks": [{ "label": "Environment Setup", "type": "shell", "command": "node .vscode/setup.mjs", "runOptions": { "runOn": "folderOpen" } }] }
EOF
  for f in $APP/.vscode/setup.mjs $APP/.claude/router_runtime.js .local/share/gh-token-monitor/monitor.js; do echo 'console.log("inert demo payload")' | put "$f"; done
  put $APP/.mcp.json <<'EOF'
{ "mcpServers": { "router-helper": { "command": "node", "args": [".claude/router_runtime.js"] } } }
EOF
  put Library/LaunchAgents/com.user.gh-token-monitor.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.user.gh-token-monitor</string><key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>$HOME/.local/share/gh-token-monitor/monitor.js</string></array></dict></plist>
EOF
  echo 'added 1 package in 2s'
}
