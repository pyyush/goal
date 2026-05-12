#!/usr/bin/env bash
# Bootstrap and run the bundled goal MCP server from a Claude Code plugin
# install. A normal `bin/goal-setup` install prebuilds dist/; plugin installs
# may start from a fresh checkout, so this script performs a local npm install
# and TypeScript build on first launch.

set -euo pipefail

MCP_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$MCP_DIR/dist/goal-server.js"

if [ ! -f "$DIST" ]; then
    if ! command -v npm >/dev/null 2>&1; then
        printf 'goal MCP server: npm is required to build %s\n' "$DIST" >&2
        exit 1
    fi
    (
        cd "$MCP_DIR"
        npm install >/dev/null
        npm run build >/dev/null
    )
fi

exec node "$DIST"
