#!/bin/sh
set -eu

HOST_KEY_PATH="${HOST_KEY_PATH:-/app/data/host.key}"
HOST_KEY_DIR="$(dirname "$HOST_KEY_PATH")"

mkdir -p "$HOST_KEY_DIR"

if [ ! -f "$HOST_KEY_PATH" ]; then
  ssh-keygen -q -t ed25519 -N "" -f "$HOST_KEY_PATH"
fi

exec node server.js
