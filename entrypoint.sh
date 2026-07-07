#!/bin/bash
# Start opencode server in the background
opencode serve --port 4096 --hostname 127.0.0.1 &

# Wait a moment for server to start
sleep 2

# Start the main application
exec bun --watch app/server.ts
