#!/bin/bash
cd "$(dirname "$0")"
while true; do
  echo "[$(date)] Starting server..." >> crash.log
  node server.js 2>> crash.log
  EXIT_CODE=$?
  echo "[$(date)] Server exited with code $EXIT_CODE" >> crash.log
  if [ $EXIT_CODE -eq 0 ]; then
    break
  fi
  echo "[$(date)] Restarting in 2 seconds..." >> crash.log
  sleep 2
done
