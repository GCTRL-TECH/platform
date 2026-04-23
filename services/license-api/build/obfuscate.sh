#!/bin/bash
set -e

npm run build  # TypeScript → dist/

npm install -g javascript-obfuscator --quiet

echo "=== Obfuscating license-api ==="
javascript-obfuscator dist/ \
  --output dist-obfuscated/ \
  --compact true \
  --control-flow-flattening true \
  --control-flow-flattening-threshold 0.5 \
  --string-array true \
  --string-array-encoding rc4 \
  --string-array-threshold 0.75 \
  --rotate-string-array true \
  --dead-code-injection false \
  --source-map false

echo "=== Obfuscation complete ==="
