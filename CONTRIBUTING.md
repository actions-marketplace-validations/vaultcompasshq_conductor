# Contributing

## Getting set up

    pnpm install
    pnpm build
    pnpm test

Three gates that must pass before anything is committed:

    pnpm typecheck
    pnpm lint
    pnpm test

`pnpm test` runs the unit suites plus one end-to-end test that clones a
real guard repository and drives a real commit through the generated hook.
That test skips, with a message naming what was missing, when the sibling
checkouts and builds it needs are not on the machine. A skip is not a pass;
if you are changing anything that touches the gates, get it running.

## Tests

Fixtures under `tests/fixtures` are the literal stdout of a real gate
binary, captured once and committed unchanged, with the gate version in the
file name. Do not hand-write one. A hand-written fixture only proves the
normalizer agrees with whoever wrote the fixture, which is the failure this
directory exists to avoid; `tests/fixtures/README.md` records the exact
command behind each file.

Assertions about where a hook lands are made by driving a real commit and
observing whether it was refused, not by comparing a path string. A path
assertion can agree with the same mistake the code makes, and in a sibling
tool it did.

## Public repository hygiene

`pnpm lint` runs `scripts/check-public-hygiene.mjs` over every tracked
file. It fails on four things:

- a token whose SHA-256 matches an entry in the blocklist. The blocklist
  holds hashes only. The plaintext it stands for is never written down in
  this repository, which is the point: a plaintext blocklist leaks exactly
  the names it exists to hide.
- an absolute home-directory path that runs through a `projects` directory,
  which is a local machine layout and has no business in a public tree.
- any other absolute path rooted somewhere per-machine: a home directory on
  either platform (`/Users`, `/home`), or a temporary directory
  (`/var/folders`, `/private`). The rule above needs a `projects` segment,
  so it missed the shape that actually turns up, which is a scratch
  repository or a captured fixture carrying the path it was made in. Every
  one of the four roots takes the same rule: two or more segments under the
  root is a finding, one is not, so naming a root in prose is fine. A URL
  never is, however its path starts, because only a start of line,
  whitespace, an equals sign or a quote may come before the leading slash.
- an em dash or an en dash. Prose and commit messages here are plain ASCII.

To add a blocklist entry, hash the lowercased token with SHA-256 and paste
the digest into `BANNED_HASHES`. Add it to every repository in the family
in the same change: a blocklist that differs per repository protects the
intersection and advertises the difference, which is the same as not
protecting it at all.

Two files are allowlisted from the content checks, this one and the guard
script itself, because both have to discuss the rules they enforce. An
allowlist exempts a file's contents, never its name: a file path is visible
on a public tree whether or not its contents are scanned.

## Commit messages

Plain ASCII prose. No backticks, no angle brackets, and no arrows: each of
those has been eaten or misread by a shell somewhere in this family's
history. Write "escalates 7d then 30d then permanent" rather than an arrow
chain.

## Releasing

### The first version, by hand, once

npm only exposes the trusted-publisher setting on a package that already
exists on the registry, so the very first publish of a new name cannot go
through OIDC. Tagging alone does not release the first version: the
workflow's publish step has nothing to authenticate with and fails. If
`@vaultcompass/conductor` is already on npm, this section is finished
forever; skip to the next one.

Merge the version bump and wait for `main`'s CI to go green on the merge
commit, the same as any release. Then, from that commit on a maintainer's
machine:

    npm login
    pnpm install --frozen-lockfile
    pnpm build
    pnpm publish --access public

Then configure the trusted publisher for the package on npmjs.com, naming
this repository and `.github/workflows/release.yml`. Only after that can an
OIDC publish from Actions succeed.

Now tag that same commit and push, exactly as below. That run finds its
version already on the registry, skips its own publish rather than failing
on a duplicate, and creates the GitHub Release. Every later release is the
ordinary flow and touches none of this.

### Everywhere a version is pinned

A release bumps more than one file, and the list is short enough that
there is no excuse for missing one. Grep for the outgoing version and
check every hit, in the same pull request:

- `package.json`, the `version` field. This is the package itself.
- `action.yml`, the `conductor-version` input's default. The Action
  installs the umbrella rather than running the caller's own copy, so this
  default is the version that judges an adopter's pull requests. A release
  that bumps `package.json` and leaves this behind publishes a version
  nothing runs.
- `README.md`, the CI example's four `*-version` lines.

The three GATE version defaults in `action.yml`, `dep-guard-version`,
`vault-guard-version` and `intent-guard-version`, are on their own clock:
they change when one of those products ships something this umbrella needs,
not when this package releases. Bumping one is its own pull request and its
own decision, and it belongs beside the `TRUST_BASE_MIN_VERSION` table in
`src/gate-runner.ts`, which is the other place this repository names a gate
version. Check that the two agree: the Action must not install a build
below the floor that table sets, or every adopter's pull request reports
that gate as could-not-run.

### Every release after that

Open a pull request that bumps the version everywhere the list above names.
Let it merge like any other change, and wait for `main`'s own CI to go green
on the merge commit. Only then tag that commit and push the tag:

    git tag v0.2.0
    git push origin v0.2.0

The tag push is what triggers the publish. Never tag and push a version
straight from a local branch without going through a pull request and a
green `main` first; the release workflow re-runs build, typecheck, lint,
and test before it publishes, but that is a second check, not a substitute
for `main`'s own CI having already passed.

## Findings log

[FINDINGS.md](./FINDINGS.md) is a durable, append-by-PR record of what
conductor actually did when run against real changes, including runs that
caught nothing. Open a PR to append a row after you run it against real
code, your own or someone else's.
