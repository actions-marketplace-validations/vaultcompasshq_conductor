# Changelog

Notable changes to conductor. Format based on
[Keep a Changelog](https://keepachangelog.com/). What a version number
promises is the same contract the guard repositories use: the action tag and
the published package version are two numbers, and an action-only release
moves the tag while the package stays where it is.

This file starts at 0.4.1. Releases before it are described by their GitHub
release notes, which are generated from the commit history. It exists from
here because `scripts/lib/release-kind.mjs` now requires an entry before it
will classify a tag as an action-only release: a tag with no entry is far more
likely to be a version bump someone forgot to commit than a deliberate one.

## [Unreleased]

## [0.4.2] - 2026-09-18

**An action-only release. The tag moves; the npm package does not.**
`@vaultcompass/conductor` stays at 0.4.0 on npm and the action's
`conductor-version` default stays `0.4.0`.

### Fixed

- The release workflow's "Decide the release kind" step ran before
  `Install dependencies`, but the classifier it runs imports the `yaml`
  package. The v0.4.1 tag failed at that step with `Cannot find package
  'yaml'` before it could decide anything: nothing was published and no
  GitHub Release was created, which is the fail-closed outcome the workflow
  is built for, but it also means v0.4.1 has no Release page. Install now
  runs first. This tag carries everything v0.4.1 described below.

## [0.4.1] - 2026-09-18

**An action-only release. The tag moves; the npm package does not.** Nothing in
the umbrella changed, so `@vaultcompass/conductor` stays at 0.4.0 on npm and
the action's `conductor-version` default stays `0.4.0`.
`vaultcompasshq/conductor@v0.4.1` installs `@vaultcompass/conductor@0.4.0`.

### Security

- **The action no longer runs install scripts, and verifies what it
  installed.** The install step ran `npm install -g` with no
  `--ignore-scripts` on a runner holding the job's token, so every package in
  the resolved tree had arbitrary code execution there on every run. The four
  things this action installs are control inputs: they decide whether a pull
  request may merge.

  It now also runs `npm audit signatures` over the installed tree. That needs
  a root manifest to cover anything: the audit walks the tree's edges out, and
  a global install leaves `<prefix>/lib` with no manifest, so without one the
  audit covers the gates' dependencies and silently skips all four gates.
  Measured on this exact tree: 32 signatures and 8 attestations without the
  manifest, 36 and 12 with it.

  **What the verification proves, stated narrowly** because the obvious
  summary is wrong: it asks the registry for each name and version in the
  tree, the four gates included, and checks the signature served back. It does
  **not** read the installed files, so a tampered install is invisible to it;
  it does **not** defeat a compromised registry, which signs what it serves;
  and a **missing** attestation is not a failure, so it does not require
  provenance even though all four packages publish it.

### Fixed

- **A floor on the npm client, so the action cannot report a clean install as
  tampered with.** `npm audit signatures` is not version-stable: below npm
  **10.5.2** it fails on an untampered install of these very packages, because
  the client's own bundled keys and TUF root are stale. On 10.5.0 it reports
  *"Someone might have tampered with these packages since they were published
  on the registry!"*, naming ours; on 10.2.4 it is `EEXPIREDSIGNATUREKEY`.
  Bisected against a real four-gate install, with a cold cache and a fresh
  home so no newer client could have primed the TUF root or the key set:
  8.19.4, 9.9.4, 10.2.4, 10.5.0 and 10.5.1 fail; 10.5.2 and later pass, with
  10.5.2 verifying the same package and attestation counts as current npm
  rather than a reduced set.

  This action does not install Node itself, by design: the documented workflow
  has the caller do that. So the floor is enforced rather than assumed, and
  the refusal names the npm it found.

  Note that a bare major is not enough: **Node 22.0.0 ships npm 10.5.1**,
  inside the failing band. Pin 20.13.0 or later, or 22.1.0 or later.

### Added

- **`scripts/lib/release-kind.mjs` and `scripts/classify-release-tag.mjs`**,
  ported from the guard repositories. The release workflow knew exactly one
  tag shape, "v" plus the package version, which is right for a package
  release and wrong for an action-only one. An action-only tag now has to
  clear every condition before anything is published: exact semver, ahead of
  the package version, an entry in this file, the package already on the
  registry, and an action default that still matches. A tag failing any of
  them is refused rather than treated as the quieter kind of release.

- **This file.**
