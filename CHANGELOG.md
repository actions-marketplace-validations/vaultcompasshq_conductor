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

- **The text report now carries conductor's own version, as its first
  line** (`conductor <version>`), sourced from the same `package.json`
  version the SARIF renderer already carries. This report is also the
  pull-request comment body, and until now nothing on it said which
  conductor produced it. Left off the one-line clean summary on purpose;
  that line stays exactly one line.
- **The `pr-comment` step's text run now takes `--compact-on-refusal`.**
  When the trust base was refused and no gate ran, the comment shrinks to
  three lines, the version, the could-not-run reason (the same sentence the
  verdict already carries), and a pointer at the "Run the gates" step log,
  instead of the full per-gate report. An adopter with no policy on the
  base ref yet otherwise got a full sticky comment on every push whose
  entire content was "refused, nothing checked". The new `--compact-on-refusal`
  CLI flag is a no-op on any run that was not refused; exit codes, verdict
  semantics, and when the comment posts are unchanged.
- **README: the advisory-check section now includes a complete copy-paste
  job** (checkout, setup-node, an explicit fetch of the base ref, and the
  conductor step with `pr-comment: true`), with `continue-on-error: true` on
  every fallible step so a required job never goes red over a hung or failed
  advisory step, and a note that 0.4.5 already self-fetches the base so the
  explicit fetch step is belt and braces rather than a requirement.

## [0.4.5] - 2026-09-20

**A package release. The tag and the package converge.**
`@vaultcompass/conductor` moves to 0.4.5 on npm and the action's
`conductor-version` default moves to `0.4.5` in lockstep, the same number
the `v0.4.5` tag names. Versions 0.4.1 through 0.4.4 were action-only
releases that moved the tag while the package stayed at 0.4.0; this release
re-converges the two numbers.

- Fixed the validate step's version-shape check to refuse a leading zero
  (`01.2.3`, `0.6.00`), matching the sibling scanners' regex; npm reads a
  value it cannot parse as a version as a dist-tag instead, which is the
  exact hole this check exists to close.
- Added a test covering the same-minor, lower-patch backward-pin refusal
  (the W3 patch-comparison arm), the only one of the four version inputs
  reachable through it being intent-guard.
- README: added a canonical `uses: vaultcompasshq/conductor@v0.4.4` example
  and updated the other consumer-facing examples to match; `uses: ./` reads
  `action.yml` from the caller's own tree and is not a form a real consumer
  should copy.
- **A pull-request run against a base ref with no `.guardrails.yaml` now
  reports could-not-run through the same path as any other unusable trust
  base**, with the reason in the text report (stdout) rather than only on
  stderr, a `verdict: exit 2` line, and the head's own gates named as
  `DID NOT RUN (preparation-failed)`. This case already exited 2 before this
  change, but through an uncaught `PolicyError` that printed one line to
  stderr and left stdout (and the SARIF file) empty, so a run in advisory
  mode read as a red step with nothing useful attached, and the `pr-comment`
  step had no report text to post. Two consumer teams hit exactly this on
  their first pull request, before `conductor init` had landed on their base
  branch (see FINDINGS.md, 2026-09-20). This is a judgment call about which
  side of the line a case sits on: a base ref that DOES carry a policy file
  in which every gate is disabled or deferred is a decision someone wrote
  down on purpose and still reports a clean exit 0; only an ABSENT config on
  the base is treated as could-not-run.
- **`action.yml` now shallow-fetches the trust base for a pull-request run**
  when the checkout does not already carry it (the `actions/checkout`
  default is `fetch-depth: 1`, the head commit alone), so a consumer no
  longer has to add their own fetch step to make `origin/<base>` resolve.
  The fetch is a no-op when the ref already resolves, never fails the job
  when it cannot reach the remote (a `::warning::` names the exact command
  to add instead), and uses an explicit `<ref>:refs/remotes/origin/<ref>`
  refspec rather than a bare `git fetch origin <ref>`, which only updates
  `FETCH_HEAD` and would have left the ref just as unresolvable on a
  single-branch checkout.

## [0.4.4] - 2026-09-19

**An action-only release. The tag moves; the npm package does not.**
`@vaultcompass/conductor` stays at 0.4.0 on npm and the action's
`conductor-version` default stays `0.4.0`.

### Added

- **A `pr-comment` opt-in input on the Action**, for an advisory
  (non-required) run whose findings would otherwise live only in the job's
  exit code and log. Set to exactly `"true"` (default `"false"`, so an
  existing consumer is unaffected), it posts conductor's own text report as a
  pull request comment, only on a `pull_request` or `pull_request_target`
  event and only with `permissions: pull-requests: write` granted on the
  calling job. The comment is **sticky**: a hidden marker in the body lets a
  re-run find and update that same comment rather than adding a new one every
  push. **Fork-safe by construction**: the default `GITHUB_TOKEN` on a fork
  pull request is read-only regardless of the granted permission, so the post
  fails there; the step catches that, prints a `::warning::`, and continues
  rather than failing the job or changing the gate's own verdict. The report
  reaches `gh` by file, never interpolated into a command line, using `gh
  api`'s `-F` (file-read) form rather than `-f` (literal-string), which
  matters because they take the same `key=@path` shape and only one of them
  reads the file. The sticky match requires the marker AND that the existing
  comment was authored by the GitHub Actions bot, not the marker alone: on
  `pull_request_target`, which hands this step a write token even though the
  pull request is untrusted, anyone who can comment on the pull request
  could otherwise plant the marker in their own comment ahead of conductor's
  first run and have every later run silently PATCH it. An optional
  `pr-comment-marker` input overrides the built-in marker, for a workflow
  that runs this Action more than once against the same pull request (one
  package in a monorepo per run); left unset, behaviour for a single
  invocation is unchanged. See the README's "The report as a pull request
  comment" section, including the note there on the real-`gh` smoke test
  (`scripts/tests/pr-comment-smoke.test.mjs`) this surface needs before a
  release, since the offline suite's `gh` shim cannot distinguish `-f` from
  `-F`.

### Changed

- **The umbrella now installs `vault-guard` 1.8.0 and `dep-guard` 0.7.0 by
  default, up from 1.7.0 and 0.6.0.** Both releases fail closed on an empty
  scan rather than reporting one that never ran as a clean pass. Their own
  `TAG_VAULT_GUARD_*` and `TAG_DEP_GUARD_*` constants in `action.yml` move
  in lockstep with the defaults, since those constants are what the
  pull-request backward-pin rule measures a pin against. `intent-guard-version`
  stays at `1.5.2` and `conductor-version` stays at `0.4.0`; neither changes
  in this release.

  **The consumer cost.** On a pull request, the backward-pin rule (added in
  0.4.3) now refuses `vault-guard-version` below `1.8.0` or `dep-guard-version`
  below `0.7.0`, the same as it already refused older pins of the other two
  inputs. A workflow carrying either of those lines below the new floor is
  refused rather than run, because this tag ships the newer scanners and the
  rule will not let a pull request judge itself with an older one. The
  migration is to remove the input, whose default is the version this tag
  ships, or to raise it to `1.8.0` / `0.7.0` or newer.

## [0.4.3] - 2026-09-18

**An action-only release. The tag moves; the npm package does not.**
`@vaultcompass/conductor` stays at 0.4.0 on npm and the action's
`conductor-version` default stays `0.4.0`. What moves is the intent gate the
action installs.

### Security

- **On a pull request, the four `*-version` inputs may not pin BACKWARD.** The
  validate step checked that each input is an exact version and nothing more,
  which is not the control for version choice: on a same-repo `pull_request`
  event GitHub runs the workflow file from the head, so those four pins are
  written by the pull request being judged. Once a gate has two published
  versions, a pull request could pin back to the release that predates the rule
  which would have caught it, clear the shape check, and be judged by the rule
  set it chose for itself. That is the same class of hole as an input that
  turns pull-request mode off, which this action refuses to offer, except that
  deleting a control reads as deleting a control while `intent-guard-version:
  1.4.0` reads as ordinary version management.

  Where `GITHUB_BASE_REF` is set, the step now refuses any of the four inputs
  naming a version below the one this action tag ships, naming both numbers and
  the fix, which is to remove the input. Pinning **forward** is still accepted
  there, on an assumption the rule does not enforce: that a newer gate is at
  least as strict. Forward pins are not bounded.

  Each input has its own constant in `action.yml`, separate from
  `TRUST_BASE_MIN_VERSION` in `src/gate-runner.ts` even where the numbers
  agree. That floor is flag compatibility, the oldest build that understands
  `--trust-base`; these are the tested versions this tag ships, and one
  constant serving both is how raising one silently raises the other.

  **Where it fires** is exactly where `GITHUB_BASE_REF` is set, which is
  `pull_request` and `pull_request_target`. Push runs are out of scope and the
  shape check stays their only version gate. That is a statement of scope, not
  a safety argument: a push to an unprotected branch runs that branch's own
  workflow file, written by the same author, and is as author-controlled as a
  pull request. It is not covered.

  **What this does not cover:** forks, where the base repository's workflow
  file runs, so a fork author never writes the pins that judge them (the rule
  still fires on a fork pull request and judges the base workflow's own pins,
  so a deliberate backward pin there refuses every fork run); `merge_group`
  events, where `GITHUB_BASE_REF` is empty although the queue branch carries the
  pull request's commits and workflow file, so a consumer whose only required
  check runs there gets nothing from this rule and should keep the
  `pull_request` run required too; and a pull request that deletes the step or
  moves the `uses:` pin, for which branch protection with review required for
  `.github/workflows` remains the control.

  **The cost today** is not one refusal and not one input. Every one of the four
  has published versions below its constant, and counted from the registry on
  2026-09-18 there are 46 pins that a pull request may no longer carry:
  `conductor-version` has 6 below 0.4.0 (0.2.0 through 0.3.0),
  `dep-guard-version` 8 below 0.6.0, `vault-guard-version` 25 below 1.7.0, and
  `intent-guard-version` 7 below 1.5.2. A workflow carrying any of them now
  fails on a pull request. **The migration is to remove the input**, whose
  default is the version this tag ships, or to raise it to that version or
  newer.

  What each input loses differs, and it is worth being exact about it.
  `dep-guard-version` and `vault-guard-version` below the constant were already
  degraded rather than working: their `TRUST_BASE_MIN_VERSION` floors in
  `src/gate-runner.ts` are the same numbers, 0.6.0 and 1.7.0, so on a
  pull-request run the umbrella **withheld** `--trust-base` from those builds.
  Withheld is not a failure: the gate still ran, read its own control inputs
  from the tree under judgment, and was reported on the run's report line, in
  the summary and as a `conductor/trust-base-not-passed` SARIF notification.
  Those pins now become a hard refusal instead. `intent-guard-version` 1.4.0,
  1.5.0 and 1.5.1 were fully functional in pull-request mode, since that gate's
  floor is 1.4.0 and sits below the constant, and they are now refused outright;
  1.2.x and 1.3.x were withheld before. The sharpest cost is
  `conductor-version`: the umbrella holds no floor on itself, so its 6 older
  pins went from fully working to refused with no prior mechanism at all.

### Changed

- **The `intent-guard-version` default moves from `1.4.0` to `1.5.2`.**
  intent-guard 1.5.1 refused `--paths ''`, which is exactly what the umbrella
  sends on a pull request whose change set is empty, so that version turns an
  empty diff into a failed gate. 1.5.2 fixes it. **Never pin 1.5.1 here.** The
  pull-request rule above measures `intent-guard-version` against 1.5.2 from
  this tag on.

  Unchanged, and deliberately: `TRUST_BASE_MIN_VERSION` in
  `src/gate-runner.ts` and the "intent-guard from 1.4.0" line in the README
  both stay at 1.4.0. Those are the floor at which intent-guard understands
  `--trust-base`, which is a statement about a flag rather than about what this
  tag ships, and 1.4.0 still understands it.

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
