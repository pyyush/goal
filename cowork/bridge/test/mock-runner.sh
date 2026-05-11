#!/usr/bin/env bash
# cowork/bridge/test/mock-runner.sh — Configurable mock runner for bridge tests.
#
# Env vars:
#   MOCK_BANNER        — text printed to stdout on start (default: "mock-runner started")
#   MOCK_429_AFTER     — seconds before emitting a "429 Too Many Requests" event/line
#                        (0 or unset = never emit 429)
#   MOCK_500_AFTER     — seconds before emitting a "500 internal server error" event/line
#                        (0 or unset = never emit 500)
#   MOCK_EXIT_AFTER    — seconds before exiting (0 or unset = run until SIGTERM)
#   MOCK_SLEEP_STEP    — polling granularity in seconds (default: 0.1)
#   MOCK_FORMAT        — 'ndjson' or 'line' (default: 'line')
#                        'ndjson' mode emits structured NDJSON events on stdout:
#                          thread.started (with session_id)
#                          turn.started
#                          turn.completed (with usage tokens) — OR —
#                          turn.failed (with rate_limit payload if MOCK_429_AFTER fires)
#                          error (with server_error payload if MOCK_500_AFTER fires)
#   MOCK_SESSION_ID    — session_id to use in thread.started (default: mock-session-<PID>)
#   MOCK_TURNS         — number of successful turn.completed to emit before exiting
#                        (ndjson mode only; 0 or unset = run until exit trigger)
#   MOCK_TURN_INTERVAL — seconds between turns in ndjson mode (default: 0.5)
#
# The script is designed to be spawned by goal-bridge as the runner child.
# It sleeps in a loop, checking timers, so signals are handled promptly.

set -euo pipefail

BANNER="${MOCK_BANNER:-mock-runner started}"
MOCK_429_AFTER="${MOCK_429_AFTER:-0}"
MOCK_500_AFTER="${MOCK_500_AFTER:-0}"
MOCK_EXIT_AFTER="${MOCK_EXIT_AFTER:-0}"
STEP="${MOCK_SLEEP_STEP:-0.1}"
FORMAT="${MOCK_FORMAT:-line}"
SESSION_ID="${MOCK_SESSION_ID:-mock-session-$$}"
TURNS="${MOCK_TURNS:-0}"
TURN_INTERVAL="${MOCK_TURN_INTERVAL:-0.5}"

if [ "$FORMAT" = "ndjson" ]; then
    # ---- NDJSON mode (Codex-style) ----------------------------------------
    # Emit thread.started immediately.
    printf '{"type":"thread.started","session_id":"%s","ts":"%s"}\n' \
        "$SESSION_ID" "$(date -u +%FT%TZ)"

    START=$(date +%s)
    ELAPSED=0
    DID_429=0
    DID_500=0
    TURNS_DONE=0
    IN_TURN=0

    # Emit first turn.started.
    printf '{"type":"turn.started","session_id":"%s","ts":"%s"}\n' \
        "$SESSION_ID" "$(date -u +%FT%TZ)"
    IN_TURN=1

    while true; do
        sleep "$STEP" 2>/dev/null || sleep 1

        NOW=$(date +%s)
        ELAPSED=$(( NOW - START ))

        # Emit 429 if configured and threshold reached.
        if [ "$MOCK_429_AFTER" -gt 0 ] && [ "$DID_429" -eq 0 ] && [ "$ELAPSED" -ge "$MOCK_429_AFTER" ]; then
            printf '{"type":"turn.failed","session_id":"%s","ts":"%s","error":{"message":"429 rate_limit Too Many Requests","code":429}}\n' \
                "$SESSION_ID" "$(date -u +%FT%TZ)"
            DID_429=1
            IN_TURN=0
            # Exit after fault so bridge detects clean stop.
            exit 1
        fi

        # Emit 500 if configured and threshold reached.
        if [ "$MOCK_500_AFTER" -gt 0 ] && [ "$DID_500" -eq 0 ] && [ "$ELAPSED" -ge "$MOCK_500_AFTER" ]; then
            printf '{"type":"error","session_id":"%s","ts":"%s","error":{"message":"500 internal server error","code":500}}\n' \
                "$SESSION_ID" "$(date -u +%FT%TZ)"
            DID_500=1
            IN_TURN=0
            exit 1
        fi

        # Emit turn.completed after TURN_INTERVAL seconds (simulated turn).
        # Use integer arithmetic only (TURN_INTERVAL default 0.5 → treat as 1).
        TURN_INT="${TURN_INTERVAL%.*}"
        [ -z "$TURN_INT" ] || [ "$TURN_INT" = "0" ] && TURN_INT=1
        if [ "$IN_TURN" -eq 1 ] && [ "$ELAPSED" -ge "$TURN_INT" ]; then
            printf '{"type":"turn.completed","session_id":"%s","ts":"%s","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":50}}\n' \
                "$SESSION_ID" "$(date -u +%FT%TZ)"
            IN_TURN=0
            TURNS_DONE=$(( TURNS_DONE + 1 ))

            # If MOCK_TURNS set and reached, exit cleanly.
            if [ "$TURNS" -gt 0 ] && [ "$TURNS_DONE" -ge "$TURNS" ]; then
                exit 0
            fi

            # Start next turn.
            START=$(date +%s)
            ELAPSED=0
            printf '{"type":"turn.started","session_id":"%s","ts":"%s"}\n' \
                "$SESSION_ID" "$(date -u +%FT%TZ)"
            IN_TURN=1
        fi

        # Exit if configured and threshold reached.
        if [ "$MOCK_EXIT_AFTER" -gt 0 ] && [ "$ELAPSED" -ge "$MOCK_EXIT_AFTER" ]; then
            if [ "$IN_TURN" -eq 1 ]; then
                printf '{"type":"turn.completed","session_id":"%s","ts":"%s","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":50}}\n' \
                    "$SESSION_ID" "$(date -u +%FT%TZ)"
            fi
            exit 0
        fi
    done

else
    # ---- Legacy line mode (stderr-based) -----------------------------------
    printf '%s\n' "$BANNER"

    START=$(date +%s)
    ELAPSED=0
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
fi
