#!/bin/sh
set -eu

HOST_KEY_PATH="${HOST_KEY_PATH:-/app/data/host.key}"
HOST_KEY_DIR="$(dirname "$HOST_KEY_PATH")"
BUILD_COMMIT_FILE="/app/.build-commit"
export HOST_KEY_PATH

if [ "${APP_BUILD_COMMIT:-unknown}" = "unknown" ] && [ -f "$BUILD_COMMIT_FILE" ]; then
  APP_BUILD_COMMIT="$(cat "$BUILD_COMMIT_FILE")"
fi
export APP_BUILD_COMMIT

mkdir -p "$HOST_KEY_DIR"

if [ ! -f "$HOST_KEY_PATH" ]; then
  ssh-keygen -q -t ed25519 -N "" -f "$HOST_KEY_PATH"
fi

exec node server.js
