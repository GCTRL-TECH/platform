#!/bin/bash
# Compile the KEX engine to native .so via Cython (source never ships).
# Mirrors the inline compile in Dockerfile.prod. Run from services/kex/.
set -e

echo "=== Cython: compiling KEX engine to native .so ==="
pip install cython==3.0.11 setuptools --quiet

find src -name '*.py' ! -name 'main.py' ! -name '__init__.py' -print0 \
  | xargs -0 python -m Cython.Build.Cythonize -3 -i -j 4
find src -name '*.py' ! -name 'main.py' ! -name '__init__.py' -delete
find src -name '*.c' -delete
rm -rf build

echo "=== Compilation complete — shipped modules ==="
find src -name '*.so' -o -name '*.py' | sort
