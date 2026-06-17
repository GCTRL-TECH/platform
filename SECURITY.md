# Security Policy

We take the security of Ground Control (GCTRL) seriously. Thank you for helping
keep GCTRL and its users safe.

## Reporting a vulnerability

**Please report security issues privately — do not open a public GitHub issue.**

Email **fabio@5monti.com** (or **security@5monti.com** if set up for your tenant) with:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected component/version, and
- any suggested remediation.

We will acknowledge your report, work with you on a fix, and coordinate
disclosure. Please give us reasonable time to release a fix before any public
disclosure. We're happy to credit you for the report unless you prefer to remain
anonymous.

## Supported versions

GCTRL ships as a rolling release. Security fixes are applied to the **latest**
released images (`ghcr.io/gctrl-tech/*:latest`). Always run the latest version —
update with:

```bash
curl -fsSL https://gctrl.tech/update | bash
```

## Hardening your deployment

GCTRL is designed to run on your own infrastructure and keeps data local by
default. Operator-side hardening (don't expose the data-layer ports, per-install
database passwords, securing the API for remote agents) is documented in
**[Securing Your Deployment](https://gctrl.tech/docs/security)**.

## Scope

In scope: the GCTRL platform services (api, agent, kex, fuse, web, portal,
license-api) and the install/update scripts. Out of scope: vulnerabilities in
third-party dependencies that are already publicly known and tracked upstream
(please report those upstream), and issues that require an already-compromised
host or physical access.
