#!/bin/bash
set -e

echo "=== PyArmor: obfuscating KEX ==="
pip install pyarmor==8.5.11 --quiet

pyarmor gen \
  --output dist/obfuscated \
  --recursive \
  --platform linux.x86_64 \
  src/

echo "=== Obfuscation complete ==="
ls -la dist/obfuscated/
