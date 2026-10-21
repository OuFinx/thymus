# Run thymus daily

A LaunchAgent that runs `thymus diff` every day at 10:00 and posts a macOS notification when something new or changed appears. Thymus does not install it for you.

1. Replace `/opt/homebrew/bin/node` with `which node` and `/path/to/thymus` with your checkout.
2. Save as `~/Library/LaunchAgents/dev.thymus.diff.plist`.
3. Load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.thymus.diff.plist`
4. The next `thymus diff` will show this agent itself as new. That is the point: approve it with `thymus approve launchagents:user/dev.thymus.diff`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.thymus.diff</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>/opt/homebrew/bin/node /path/to/thymus/bin/thymus diff &gt; "$HOME/.thymus/last-diff.txt" 2&gt;&amp;1 || osascript -e 'display notification "Something new can run on this Mac. Run: thymus diff" with title "Thymus" sound name "Basso"'</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>10</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

Remove it with `launchctl bootout gui/$(id -u)/dev.thymus.diff` and delete the plist.

Note: `thymus diff` exits 1 on new or changed items and 2 on usage errors (for example no baseline yet), so both cases notify.
