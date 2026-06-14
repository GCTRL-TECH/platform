#!/bin/bash
# Compile the FUSE engine to native .so via Cython (source never ships).
# Mirrors the compiler stage in Dockerfile.prod. Run from services/fuse/.
set -e

pip install cython==3.0.11 setuptools --quiet
find src -name '*.py' ! -name 'main.py' ! -name '__init__.py' -print0 \
  | xargs -0 python -m Cython.Build.Cythonize -3 -i -j 4
find src -name '*.py' ! -name 'main.py' ! -name '__init__.py' -delete
find src -name '*.c' -delete
rm -rf build
echo "=== FUSE compiled — shipped modules ==="
find src -name '*.so' -o -name '*.py' | sort
