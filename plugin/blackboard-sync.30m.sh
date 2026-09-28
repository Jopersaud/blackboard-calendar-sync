#!/bin/bash
# blackboard-calendar-sync — xbar plugin shim. All logic lives in the Node app.
# Prefer `npm run install-xbar`, which writes this with your real paths filled in.
# To install by hand: copy to ~/Library/Application Support/xbar/plugins/,
# edit the path below, and chmod +x it. ".30m." = run every 30 minutes.
# <xbar.title>Blackboard → Google Calendar sync</xbar.title>
# <xbar.dependencies>node</xbar.dependencies>
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "/path/to/blackboard-calendar-sync" && exec node dist/sync.js --xbar-output
