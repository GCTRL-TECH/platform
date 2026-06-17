# Contributing to Ground Control (GCTRL)

Thanks for your interest in improving GCTRL! This document explains how to
contribute and the licensing terms that apply to contributions.

## How to contribute

1. Open an issue describing the bug or proposal before large changes, so we can
   align on the approach.
2. Fork, branch from `main`, and keep pull requests **focused** — one logical
   change per PR.
3. Make sure the project still builds and its checks pass (Rust: `cargo check`;
   TypeScript: `tsc`; Python: `python -m py_compile`). Add tests where it makes
   sense.
4. Write clear commit messages and reference the issue you're addressing.

## Sign your work — Developer Certificate of Origin (DCO)

Every commit must be **signed off** to certify you wrote the patch or otherwise
have the right to submit it under the project's licenses. Add a `Signed-off-by`
line with:

```bash
git commit -s -m "your message"
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

By signing off you certify the [Developer Certificate of Origin
1.1](https://developercertificate.org/) for your contribution.

## Licensing of contributions (important)

GCTRL is **dual-licensed** — open source under **AGPL-3.0** and, separately,
under a **commercial license** (see [LICENSING.md](./LICENSING.md)). For that
model to work, contributions must be usable under **both**.

By submitting a contribution, you agree that:

1. Your contribution is licensed to the project and its users under the
   **GNU AGPL-3.0** (inbound = outbound), **and**
2. You grant the project maintainer (5monti / fabio@5monti.com) a perpetual,
   worldwide, royalty-free, irrevocable right to **also** license and distribute
   your contribution as part of GCTRL under the **commercial license** — so the
   dual-licensing model is preserved.

You retain copyright to your contribution. If you cannot grant (2) — for example
the work isn't yours to relicense — please say so in the PR so we can discuss
before merging.

> This section summarizes the contribution terms in plain language; it is **not
> legal advice**. If anything is unclear, ask before contributing.

## Reporting security issues

Do **not** open a public issue for vulnerabilities. See
[SECURITY.md](./SECURITY.md) for private disclosure.
