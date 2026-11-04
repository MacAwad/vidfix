#!/usr/bin/env bash
# Packs extension/ into vidfix-extension.zip for the Chrome Web Store (manifest at the zip root).
set -e
cd "$(dirname "$0")/extension"
rm -f ../vidfix-extension.zip
zip -r -q -X ../vidfix-extension.zip manifest.json src pages icons
echo "Built vidfix-extension.zip"
