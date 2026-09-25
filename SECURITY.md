# Security policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| < 0.4   | :x:                |

conductor is pre-1.0. The latest published minor is supported; earlier
minors are not patched.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Send details to **security@vaultcompass.io** (or the contact listed on
[vaultcompass.io](https://vaultcompass.io) if that address changes). Include:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected versions / components (`@vaultcompass/conductor` CLI, the
  composite GitHub Action, the pre-commit hook it installs)

We aim to acknowledge receipt within **5 business days** and coordinate a
fix and disclosure timeline with you.

## Scope

In scope: any way a pull request can influence which programs judge it or
which rules they read (the trust boundary described in
[docs/INVARIANTS.md](./docs/INVARIANTS.md)); a gate result being dropped,
downgraded, or misreported in the text or SARIF output; shell or argument
injection through the Action's inputs; supply-chain issues in the published
packages.

Out of scope: false positives or false negatives inside an individual gate
(report those to dep-guard, vault-guard, or intent-guard directly); a pull
request editing the workflow file that runs the Action, which is a property
of GitHub Actions itself and is governed by branch protection, not by this
package; third-party dependencies (report to the upstream maintainer; we
still welcome coordinated notification).

## npm provenance

Published `@vaultcompass/*` packages are built from this repository's tagged
releases through the OIDC trusted-publisher path, with npm provenance
attestations, and never from a developer machine.
