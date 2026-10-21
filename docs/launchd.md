# Run thymus daily

```sh
thymus schedule install     # ~/Library/LaunchAgents/dev.thymus.daily.plist, loaded into launchd
thymus schedule status      # installed? loaded? last run
thymus schedule uninstall   # launchctl bootout + delete that one file
```

The agent runs `thymus diff --notify` every day at 10:00 and at login. It posts a macOS notification with the count only when something is new or changed, and writes the full output to `~/.thymus/last-diff.txt`. It pre-approves itself in `~/.thymus/known.json`, so it does not show up as new. Needs a baseline first (`thymus init`).
