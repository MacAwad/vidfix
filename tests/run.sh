#!/usr/bin/env bash
# Starts the lab server and runs both browser test rounds (needs ./setup.sh first).
set -e
cd "$(dirname "$0")"
node server.js > server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
sleep 1
node test1.js
node test2.js
