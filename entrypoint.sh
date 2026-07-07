#!/bin/bash
# Always install/sync dependencies (fast no-op if lockfile matches)
bun install

# Start opencode server in the background
opencode serve --port 4096 --hostname 127.0.0.1 &

# Start the app server
exec bun --watch app/server.ts
