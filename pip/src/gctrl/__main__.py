"""Enables `python -m gctrl` as an alias for the `gctrl` console script."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
