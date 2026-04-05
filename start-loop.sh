#!/bin/bash
# Auto-restart wrapper for SillyTavern
# Usage: bash start-loop.sh
# Press Ctrl+C twice within 2 seconds to actually stop.

cd "$(dirname "$0")"

echo "=== SillyTavern Auto-Restart Wrapper ==="
echo "Press Ctrl+C twice quickly to stop."
echo ""

while true; do
    node server.js "$@"
    EXIT_CODE=$?

    if [ $EXIT_CODE -ne 0 ]; then
        echo ""
        echo "[start-loop] Server exited with error code $EXIT_CODE. Restarting in 3s..."
        sleep 3
    else
        echo ""
        echo "[start-loop] Server exited cleanly. Restarting in 1s..."
        sleep 1
    fi
done
