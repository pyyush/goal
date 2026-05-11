#!/usr/bin/env bash
# cowork/bridge/test/mock-runner.sh — Configurable mock runner for bridge tests.
#
# Env vars:
#   MOCK_BANNER        — text printed to stdout on start (default: "mock-runner started")
#   MOCK_429_AFTER     — seconds before emitting a "429 Too Many Requests" line to stderr
#                        (0 or unset = never emit 429)
#   MOCK_500_AFTER     — seconds before emitting a "500 internal server error" line to stderr
#                        (0 or unset = never emit 500)
#   MOCK_EXIT_AFTER    — seconds before exiting (0 or unset = run until SIGTERM)
#   MOCK_SLEEP_STEP    — polling granularity in seconds (default: 0.1)
#
# The script is designed to be spawned by goal-bridge as the runner child.
# It sleeps in a loop, checking timers, so signals are handled promptly.

set -euo pipefail

BANNER="${MOCK_BANNER:-mock-runner started}"
MOCK_429_AFTER="${MOCK_429_AFTER:-0}"
MOCK_500_AFTER="${MOCK_500_AFTER:-0}"
MOCK_EXIT_AFTER="${MOCK_EXIT_AFTER:-0}"
STEP="${MOCK_SLEEP_STEP:-0.1}"

printf '%s\n' "$BANNER"

START=$(date +%s)
ELAPSED=0

# Flags to avoid emitting the same error multiple times.
DID_429=0
DID_500=0

while true; do
    sleep "$STEP" 2>/dev/null || sleep 1

    NOW=$(date +%s)
    ELAPSED=$(( NOW - START ))

    # Emit 429 if configured and threshold reached.
    if [ "$MOCK_429_AFTER" -gt 0 ] && [ "$DID_429" -eq 0 ] && [ "$ELAPSED" -ge "$MOCK_429_AFTER" ]; then
        printf '429 Too Many Requests\n' >&2
        DID_429=1
    fi

    # Emit 500 if configured and threshold reached.
    if [ "$MOCK_500_AFTER" -gt 0 ] && [ "$DID_500" -eq 0 ] && [ "$ELAPSED" -ge "$MOCK_500_AFTER" ]; then
        printf '500 internal server error\n' >&2
        DID_500=1
    fi

    # Exit if configured and threshold reached.
    if [ "$MOCK_EXIT_AFTER" -gt 0 ] && [ "$ELAPSED" -ge "$MOCK_EXIT_AFTER" ]; then
        printf 'mock-runner: exiting after %ds\n' "$ELAPSED"
        exit 0
    fi
done
