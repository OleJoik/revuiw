#!/bin/bash
# Always install/sync dependencies (fast no-op if lockfile matches)
bun install

# Start opencode server in the background
opencode serve --port 4096 --hostname 127.0.0.1 &

# Start the app server.
# NOTE: no `--watch` here. This server reviews a live workspace, and the agent
# edits files in that workspace — `--watch` would restart the server on every
# such edit, killing in-flight requests (e.g. a running prompt) with a
# NetworkError and forcing the browser to reload mid-review.
exec bun app/server.ts
