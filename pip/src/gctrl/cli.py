"""`gctrl` command - installer & lifecycle for the self-hosted GCTRL stack.

This is the pip-side sibling of the curl installer. It does NOT talk to a running
instance's API (that's the separate @gctrl/cli npm tool); it installs and manages
the local Docker stack.
"""

from __future__ import annotations

import argparse
import sys

from . import __version__
from . import installer


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gctrl",
        description="Install and manage a self-hosted Ground Control (GCTRL) stack. "
                    "Docker is the only prerequisite.",
        epilog="Docs: https://gctrl.tech/docs   -   Run `gctrl install` to get started.",
    )
    p.add_argument("-V", "--version", action="version", version=f"gctrl {__version__}")
    sub = p.add_subparsers(dest="command", metavar="<command>")

    sub.add_parser("install", help="Install & start GCTRL (fetch compose + images, docker compose up)")
    sub.add_parser("update", help="Re-pull compose.yml + images and restart (preserves your .env/secrets)")
    sub.add_parser("up", help="Start an already-installed stack (docker compose up -d)")
    sub.add_parser("down", help="Stop the stack (docker compose down)")
    sub.add_parser("status", help="Show container status (docker compose ps)")
    logs = sub.add_parser("logs", help="Tail logs (docker compose logs -f)")
    logs.add_argument("--no-follow", action="store_true", help="Print current logs and exit")

    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv if argv is not None else sys.argv[1:])

    try:
        if args.command in (None, "install"):
            # No subcommand -> the thing everyone wants: install.
            if args.command is None:
                print("gctrl - Ground Control installer. Running `gctrl install`...\n"
                      "(see `gctrl --help` for up/down/status/logs/update)\n")
            installer.Installer().install()
        elif args.command == "update":
            installer.update()
        elif args.command == "up":
            installer.up()
        elif args.command == "down":
            installer.down()
        elif args.command == "status":
            installer.status()
        elif args.command == "logs":
            installer.logs(follow=not args.no_follow)
        else:  # pragma: no cover - argparse rejects unknown commands first
            _build_parser().print_help()
            return 2
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
