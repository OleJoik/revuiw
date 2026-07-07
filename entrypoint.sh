#!/bin/bash
# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  bun install
fi

# Start opencode server in the background
opencode serve --port 4096 --hostname 127.0.0.1 &

# Start the app server
exec bun --watch app/server.ts
