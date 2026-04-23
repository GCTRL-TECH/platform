#!/bin/bash
set -e

pip install pyarmor==8.5.11 --quiet
pyarmor gen --output dist/obfuscated --recursive --platform linux.x86_64 src/
echo "FUSE obfuscation complete"
