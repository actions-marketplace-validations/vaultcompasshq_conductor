# conductor

conductor is the optional layer over three guardrail gates that each work on
their own. All it adds is one policy file, one init, one hook and one report.
Delete it and every gate still runs, with exactly the configuration it had.

<!-- guardrails-family: shared block, keep it identical in dep-guard, vault-guard, intent-guard and conductor -->
The Vault & Compass guardrails are three gates over an AI-assisted coding
session: [dep-guard](https://www.npmjs.com/package/@vaultcompass/dep-guard)
checks what comes in (hallucinated package names, typosquats, tampered
lockfile entries),
[vault-guard](https://www.npmjs.com/package/@vaultcompass/vault-guard) checks
what goes out (credentials about to be committed), and
[intent-guard](https://www.npmjs.com/package/@vaultcompass/intent-guard)
checks the change against what was approved (drift from a frozen intent
contract, and change budgets). Each one installs, configures and runs on its
own;
[conductor](https://www.npmjs.com/package/@vaultcompass/conductor) is the
optional umbrella that runs them from one policy file, one hook and one
report.
<!-- /guardrails-family -->

## Why

Run all three and you have three inits, three config files, three output
shapes, and three pre-commit hooks fighting over one file. That is the
friction this repository removes, and that is all it removes:

- **one policy file**, `.guardrails.yaml`, keyed by the role each gate
  fills rather than by the product filling it;
- **one init**, which writes that file and a single pre-commit hook running
  every enabled gate whose stage is `commit`, which by default is every gate
  but the intent one;
- **one report**, as text for a terminal or as a single SARIF 2.1.0 log
  with one run per gate.

**A clean run prints one line.** Most runs are clean, and the design
constraint on all of this is that the gates must not slow development down,
with ceremony rather than runtime named as the cost. A screenful of per-gate
detail on a commit that found nothing is that cost, paid on every commit, and
it is what makes a team switch a hook off.

## Quickstart

Install the gates. Each of them is a working tool on its own, and none of
them needs this one:

```
npm install -g @vaultcompass/dep-guard @vaultcompass/vault-guard @vaultcompass/intent-guard
```

The umbrella is optional. Install it when running the three separately has
become the annoying part:

```
npm install -g @vaultcompass/conductor
```

**Globally, and that is the guidance for CI too.** A devDependency is fine
beside it for your own pre-commit hook, and nothing about a local run changed.
It is not what gates your pull requests: on a pull-request run the umbrella
never looks in `node_modules/.bin` at all, because what is installed there is
chosen by the head's own manifest and lockfile. The Action installs all four
packages itself, globally, at versions pinned in your workflow file. See "The
pull-request trust boundary" and "The Action" below.

From the repository root, look before you write:

```
conductor init --dry-run
```

That prints every file it would write or change and writes nothing. Then:

```
conductor init
```

which writes `.guardrails.yaml` with every gate listed and only the ones it
found switched on, plus one pre-commit hook running every enabled gate whose
stage is `commit`.

Commit something. A clean commit prints one line:

```
conductor: clean, nothing blocked. 2 gate(s) ran: dependencies (dep-guard), secrets (vault-guard). Deferred to a later stage: intent (intent-guard) from stage ci. 1 note(s). Re-run with --verbose for the full report.
```

A commit with a staged credential in it prints the full report and exits 1:

```
conductor run: 2 gate(s), 1 finding(s)

dependencies  dep-guard 0.2.1  exit 0  251ms  via dep-guard on path
  threshold medium   suppressed 0   ignored 0

secrets  vault-guard 1.4.6  exit 1  97ms  via vault-guard on path
  BLOCKING  critical  vault-guard/anthropic  jest.config.mjs:27:32
      Possible secret of type 'anthropic'
  threshold medium   suppressed 0   ignored not reported

  deferred  intent  intent-guard  did not run here; it runs from stage ci onwards

verdict: exit 1, 1 blocking finding(s) across 2 gate(s).
```

Both gates there are the ones you installed a moment ago, running with their
own thresholds and their own baselines. The umbrella found nothing of its
own, because it looks for nothing of its own.

## What it deliberately is not

It is not a fourth gate. It finds no bugs of its own and scans nothing.
Every finding about your code came from one of the three gates and is
labelled with which one. The only findings it adds are about the gates
themselves, and they are labelled `conductor`: a gate that is switched on
and could not run, and a gate whose output it could not read. Those exist
because a report that reads clean when nothing looked is the failure this
whole family exists to prevent.

It is not something you adopt before the gates are useful. Each gate keeps
its own config file, its own baseline, its own thresholds, and its own exit
codes. The umbrella never writes into any of them: it passes a policy to
each gate as command-line flags, which every one of the three already
treats as higher precedence than its own config. Delete this tool and every
gate still runs, with exactly the configuration it had, because nothing
here ever touched it.

It does not overrule a gate. A gate that says a commit is blocked blocks
the commit. The umbrella can add to that decision and never subtracts from
it.

## The policy file

`.guardrails.yaml`, at the repository root. `conductor init` writes one with
every gate listed and only the ones it found switched on.

```yaml
version: 1

gates:
  dependencies:
    product: dep-guard
    enabled: true
    stage: commit
    enforce: true
    options:
      fail-on: high
  secrets:
    product: vault-guard
    enabled: true
    stage: commit
    enforce: true
  intent:
    product: intent-guard
    enabled: true
    stage: ci
    # It runs and reports in CI without failing the run. Flip it to
    # true once a few pull requests show the signal is worth blocking on.
    enforce: false
    options:
      require-frozen: false

report:
  format: text
```

**Gates are keyed by role**, not by product. `dependencies`, `secrets`,
`intent`. The `product` field says which binary fills that role today.

**`enabled`** defaults to true. A gate that is enabled and whose binary
cannot be found is a blocking finding of the umbrella's own
(`conductor/gate-missing`), never a silent skip.

**`stage`** says when a gate runs: `commit`, `push`, or `ci`. Stages are
**cumulative** in that order, so a gate runs at its own stage and at every
later one, and a run at `ci` runs everything that is enabled. The defaults
are `commit` for `dependencies` and `secrets` and `ci` for `intent`.

A gate held back by the stage filter is never silent. It is one line in the
text report naming the stage it is waiting for, and a `conductor/gate-deferred`
notification in the SARIF log's `conductor` run. Its binary is not even looked
for, so a gate installed only on the CI image does not fail a developer's
commit.

**`enforce`** defaults to true. A gate with `enforce: false` runs, reports,
and its findings appear in the text report and the SARIF log exactly as an
enforced gate's do. The only thing it cannot do is change the exit code: its
blocking findings do not raise it, and its failing to run at all does not
make the run exit 2. That is the adoption ramp, so a gate can be switched on
and read for a few weeks before it is allowed to refuse anybody's commit.
`init` writes it out for every gate, and starts the intent gate at `false`.

**`options`** is handed to that gate unchanged. Each key is one of that
gate's own long flags with the leading dashes stripped: `fail-on: high`
becomes `--fail-on high`, `online: true` becomes `--online`,
`require-frozen: false` becomes `--no-require-frozen`, and a list becomes
one flag per entry. The handful of flags the umbrella supplies itself (the
JSON format flag, `--staged`, and the intent gate's `--project`) are
rejected if you also set them, rather than being silently overridden.

**There is no shared severity threshold, on purpose.** One top-level
`failOn` would read as one decision and mean three different things, so
setting one is an error rather than a knob that half works. Each gate keeps
its own threshold in its own `options` block, spelled the way that gate
spells it.

**`command`** takes an absolute path and overrides binary resolution for
that gate, for pointing at a build that is not installed anywhere.

**`report.format`** is `text` or `sarif`, and `--format` overrides it.

## Commands

`conductor init` writes the policy file and one pre-commit hook.

- `--dry-run` prints every file it would write or change and writes nothing.
- `--revert` removes exactly what a previous init wrote, and nothing else.
  A file changed since init is reported and left alone.
- `--adopt` replaces one gate's own pre-commit hook with the umbrella hook.
  Without it, init reports the collision and stops rather than stacking a
  second invocation of a gate that is already hooked. A hook the umbrella
  does not recognise is never replaced, with or without `--adopt`.
- `--force` acts on a file **conductor itself wrote** and that has changed
  since: on its own it replaces a managed hook somebody has edited, and with
  `--revert` it removes one, restoring an adopted hook if there was one. It
  never overrides a foreign-hook or gate-hook refusal, with or without
  `--adopt`: those hooks were never conductor's, and no flag here turns
  somebody else's file into one this tool may overwrite.

Init recognises the hook manager already wired into the repository. husky is
redirected to the tracked hook it maintains rather than the generated
dispatcher git runs. lefthook and the pre-commit framework are refused, with
the stanza to add to their own config file. simple-git-hooks and yorkie are
refused too, and recognised from the declaration as well as from the hook
file, because the declaration is there on a fresh clone where the generated
hook is not yet: the `simple-git-hooks` or `gitHooks` key in package.json, or
any of the standalone config files simple-git-hooks reads. Their hook text
lives in package.json, which conductor does not write, so the guidance names
the entry to add and `--force` does not override the refusal.

That refusal applies only where git actually runs `.git/hooks`. Both managers
write that directory and neither reads `core.hooksPath`, so a repository that
has pointed git somewhere else has taken their file out of play, and init
proceeds normally without mentioning them.

`conductor run` runs every enabled gate and prints one report.

- `--staged` gates the git index against HEAD, which is what the hook does.
- `--format text|sarif`.
- `--stage commit|push|ci` runs the gates at that stopping point and every
  earlier one. With no `--stage` at all, every enabled gate runs, whatever
  its stage. An unknown value is a usage error and exits 2 rather than
  quietly running everything or nothing: a typo in a CI file that runs every
  gate and one that runs none both look like a passing build.
- `--base <ref>` measures the intent gate against what this branch changed
  since `<ref>`, rather than against the index. See "Intent at a pull
  request" below.
- `--trust-base <ref>` reads the **rules** from `<ref>` instead of from the
  tree being judged: this repository's own `.guardrails.yaml`, and every
  control input of the gates that support it. See "The pull-request trust
  boundary" below. `--base` and `--trust-base` are independent and a
  pull-request run passes both: `--base` decides which paths are judged,
  `--trust-base` decides what they are judged by.
- `--spec <path>` names the spec the intent gate imports its contract from.
- `--output <path>` writes the report to a file instead of to stdout, for a
  CI step that uploads it. One line still goes to stdout, because a job whose
  only product is an uploaded artifact otherwise reads as a job that did
  nothing. A path that cannot be written is exit 2, not a green run beside a
  report nobody can read.
- `--verbose` prints the full per-gate report even when the run is clean.
  Text output only; the SARIF log never changes shape with it.
- `--gate <role>`, repeatable. A gate the policy file enables and this flag
  leaves out is named as excluded, on one line in the text report and as a
  `conductor/gate-excluded` notification in the SARIF log's `conductor` run.
  It never reaches the exit code.

### Exit codes

- **0** every enabled gate ran and none blocked.
- **1** every enabled gate ran and at least one blocked.
- **2** an enabled gate could not run: its binary is missing, it exited with
  its own could-not-run code, or it exited 1 with nothing parseable on
  stdout, which is what a rejected config file looks like from two of the
  three.

## The pull-request trust boundary

Every gate reads its own rules out of the repository it is judging. On a pull
request the author controls that repository, so without this a pull request
could turn a gate off in the same commit that carries the thing the gate
exists to catch, and the report would say the run was clean. For the umbrella
the sharpest version is `command:`, which names a program to run: a pull
request could point a gate at a script it added in the same commit.

**On a pull-request run the rules come from the base branch.** With
`--trust-base <ref>` the umbrella reads `.guardrails.yaml` from that ref with
`git show` and judges the head tree against it. A `.guardrails.yaml` in the
pull request never takes effect for that run, `command:` and `args:`
included, so **a pull request cannot change the rules it is judged by, and
cannot choose the program that judges it, as long as that program is
self-contained** (see the directory rule below). The same ref is passed
down to every gate that supports it, so their contracts, configs and
baselines come from the base branch too.

**The program is checked as well as the rules.** Reading the rules from the
base ref is worth nothing if the pull request supplies the binary that
applies them, and without this it could, two ways that both look ordinary in
a diff: a base `command:` pointing at a path inside the repository, where the
head replaces the file behind the approved path; and no `command:` at all,
where a head-committed `node_modules/.bin/<gate>` shadows the real gate,
because resolution prefers the repository's own copy over PATH so that a
project pin beats a global install.

**On a pull-request run `node_modules/.bin` is not consulted at all.** That
second shape is closed one step earlier than the first, and this is why: what
is installed there is chosen by the head's own manifest and lockfile, so it is
never approved by any ref, and a repository whose gates are devDependencies
would otherwise meet the program refusal on every ordinary pull request. So
that location is simply not searched when a trust base is set. PATH and an
absolute `command:` remain, and both still go through the program check below.
The skip is never silent: one line in the full report and one
`conductor/node-modules-skipped` note in the SARIF log name each gate and the
copy that was not taken, and a gate with nothing on PATH either is
could-not-run with `npm install -g` and the Action's version input named as
the remedy. **Outside pull-request mode nothing changes**: your own checkout
and your pre-commit hook still run the pin, which is what `pnpm exec` does in
the same repository.

**The versions that judge a pull request are pinned in the workflow file**,
and that is the point: the pull request can change its own lockfile,
manifest and `node_modules`, and none of those decide which conductor and
which gates run over it any more. Be clear about what that does not cover.
On a `pull_request` event GitHub runs the workflow as it is in the pull
request's merge commit, so a pull request that edits the workflow file can
change the pins or remove the gates step, exactly as it could rewrite any
other step in your CI. The boundary here is against the tree choosing its
own judge; the control for a workflow edit is branch protection on your
base branch with review required for `.github/workflows`, and no action can
provide that for you. Only `pull_request_target` runs the base branch's copy
of a workflow, and that event exposes the base's secrets to the pull
request's code, which is the wrong trade for a gate over untrusted changes.

One part of that is closed, and only one. Because the pins are written in a
file the pull request controls, a pull request could otherwise pin a gate
**backward** to a published version that predates the rule which would have
caught it: an exact version, so the validate step's shape check accepts it,
and a change that reads as ordinary version management. **On a pull request
the action now refuses any of the four `*-version` inputs naming a version
below the one the action tag ships.** Pinning forward is still accepted.
See "The Action" below.

So on a pull-request run a gate's program must be **outside the working tree**
(on PATH, or an absolute `command:` elsewhere on the machine), or else meet
**both** of these:

- it is a **tracked regular file whose contents are identical** at the base
  ref and at the head commit; and
- **the tree object id of its containing directory is identical** at those
  two refs, which is to say the pull request changed nothing anywhere in that
  directory's subtree.

Both are compared with `git ls-tree` on both refs and never read from the
working tree. The second is not belt and braces. A vendored gate is rarely
one file: `vendor/vault-guard` execs `vendor/impl.sh`, and a pull request
that leaves the wrapper byte for byte alone and rewrites the helper beside it
passes a per-file check while running its own code. Comparing the directory
covers every file under it at once, without this tool having to know what a
wrapper calls.

**What is and is not vetted**, exactly: the program file and everything in
its directory subtree. Anything the program reaches **outside** that
directory is not vetted at all, so an in-repo gate must be **self-contained
within its own directory**. A program at the repository ROOT is refused, and
the message says to give it a directory: at the root the containing directory
is the whole repository, so the rule would mean "no pull request may change
anything".

A symlink inside the repository is refused on **its own entry**, before its
target is considered: it is either untracked, or its tree entry is a link
rather than a regular file, and either refuses. (A symlink whose own path is
outside the tree but which points into it has its target vetted; that is the
case following the link exists for.)

Anything else is could-not-run for that gate, naming the path, and it reaches
the exit code even where the policy sets `enforce: false`, because the gate
produced no findings to un-enforce: the umbrella declined to run a program
the pull request chose.

Nothing under `node_modules` is ever base-approved, which is why the rule
above does not look there at all. Were it to look, the answer would always be
the same refusal: what is there is chosen by the head's own manifest and
lockfile and installed by a step that runs before the gates, so git has no
record of those bytes at either ref. A pull request that edits its lockfile to
pull a different build of a gate has chosen its own judge just as surely as
one that commits a stub. **Vendoring a gate still works**, on those
terms: put it in its own directory, keep everything it needs inside that
directory, and leave the whole directory alone in a pull request the gate is
meant to judge. Changing it is not forbidden, it just has to land on the base
branch first, like any other rule change.

**A change to the rules is not refused, it is proposed.** Rules legitimately
change, and a gate that blocked every such pull request would train people to
bypass it. So a policy file that differs from the base ref's is reported as
one line, `policy changed in this pull request`, the run continues under the
base ref's rules, and the change takes effect **after merge**, on the first
run whose base branch carries it. The gates' own proposals are summed with it
into one sentence, `N control change(s) proposed in this pull request`, on the
one-line summary and on the verdict, with a line each under `--verbose` and a
`conductor/control-change-proposed` notification each in the SARIF log. A
reflow, a re-quote or an edited comment is not a proposal: the two files are
compared as parsed documents.

**It fails closed.** A `--trust-base` that does not resolve is not a reason to
fall back to the pull request's own file, because that fallback is the hole:
the run exits 2 and the report **leads with the refusal**, naming the ref and
the remedy, whether or not it can name any gate. That last part matters: with
no base ref there is no base policy, so the only list of gates available is
the head's, and a head that switches every gate off leaves it empty. So is a
base ref that resolves to the head commit, or to a different commit carrying
the head's tree, both of which would put the rules back inside the tree being
judged while still reporting pull-request mode as on. Pass the base
**branch**, never a SHA: on a `pull_request` event `github.sha` is the merge
commit, which is HEAD. If the base branch has no `.guardrails.yaml` at all,
the run has no rules and exits 2 rather than using the pull request's; the
file the pull request adds decides what runs once it is on the base branch.

**Which gates are covered.** All three: dep-guard from **0.6.0**,
intent-guard from **1.4.0**, vault-guard from **1.7.0**.

The umbrella asks each gate its version and passes the flag only to a build
that understands it, so an older gate is not handed a flag it would reject. A
gate that was not put into pull-request mode read its own rules out of the
tree being judged, which is the thing this exists to prevent, so it is never
silent: it gets a line in the report, a clause on the clean one-line summary,
and a `conductor/trust-base-not-passed` notification in the SARIF log. For a
gate that IS in the table, a version that cannot be read at all is
could-not-run rather than a quiet downgrade: the umbrella cannot establish
that the gate would take its rules from the base ref, and running it anyway
would put it outside the boundary on exactly the runs where something is
already wrong.

Outside pull-request mode nothing changes. A pre-commit hook and a direct run
on your own checkout are already inside the trust boundary, and neither passes
the flag.

## Intent at a pull request

The intent gate is the only one of the three with any ceremony: its native
flow wants a contract approved before the work starts, which is a per-task
human step. That step is exactly what a pull request cannot carry, so at the
`ci` stage the umbrella stands in for it.

**What it measures.** With `--base <ref>`, the changed-path set is what this
branch changed since it forked, from
`git diff --name-only --no-renames <base>...HEAD` in the repository root.

With no `--base`, `GITHUB_BASE_REF` is used as `origin/<value>` when it is
set, and the text report says so. With neither, the intent gate runs the way
it does at a commit: against the staged index, or the paths you name.

A git failure here is **fail-closed**: could-not-run, so exit 2 for an
enforced gate and a note for an unenforced one. There is deliberately no
fallback to an empty path set, because an empty path set is what a passing
gate looks like. In Actions this is almost always a shallow checkout, so
**`actions/checkout` needs `fetch-depth: 0`** for the merge base to exist.

**Where the contract comes from**, in order:

1. `--spec <path>` on the umbrella's own command line. Typed just now, so it
   outranks everything, and a path here that is not on disk is reported
   rather than replaced: running a different contract than the one somebody
   named is the wrong kindness.
2. `<repo>/.intent-guard/intent-contract.yaml`, when it is **frozen**, and
   `<repo>/.conductor/intent-contract.yaml` after it. The native flow wins
   wherever a team has done it. Frozen is the test rather than present: an
   unfrozen contract is a draft somebody left behind, and running the gate
   against it fails every pull request on "not frozen by user" without
   checking anything.

   The second path is the directory intent-guard used before 1.3.0, which
   renamed it because `.conductor` had become the name of a different product
   in this family. Both are read, so a repository on either version is
   checked rather than blocked, and a run that used the old one says so: one
   line on the gate's contract line in the text report, and an
   `intent-guard/legacy-state-dir` notification in the SARIF log. If the
   repository holds **both** directories, the gate does not run and says so,
   naming both: that is the state intent-guard itself refuses every command
   in, so the umbrella refuses on exactly the gate's rule rather than a
   softer one. A `.conductor` holding nothing intent-guard wrote belongs to
   something else and is ignored.
3. The **first** `Spec: <path>` line in the pull request body, read from the
   event payload at `GITHUB_EVENT_PATH`. A path here that is not on disk, or
   one that leaves the repository, falls through to the next rule.
   `Spec: none` is a **waiver**: it says this pull request deliberately has
   no spec, so rule 4 is not tried and the gate reports itself skipped with
   `intent-guard/contract-waived` instead of `intent-guard/no-contract`. The
   token is exact and lowercase, a frozen contract at rule 2 still wins over
   it, and `--spec` at rule 1 still overrides it.
4. A markdown file **directly under** `docs/superpowers/specs` whose name
   relates to the branch. The branch slug is the branch name with its first
   segment (`feat/`, `fix/`) removed; a filename is reduced by stripping a
   `YYYY-MM-DD-` prefix and a trailing `-design`; the two are candidates when
   either contains the other. Several candidates are ranked: a stem **equal**
   to the slug first, then the **longest** stem, and only then the newest
   name, which is a lexical tie-break, so **date every spec**.

**A branch with neither** is a third state beside deferred and could-not-run:
the gate is switched on, it ran, and it had nothing to check. It gets one
line in the text report and one `intent-guard/no-contract` notification
in the `conductor` run, and it **never** reaches the exit code, enforced or
not. A branch with no spec is a branch this gate has no opinion about, and
turning that into a failed build is how a gate gets switched off across a
repository. A waived pull request lands in the same state and is reported
under its own `intent-guard/contract-waived` id, with its own wording on the
skipped line, in the verdict and on the one-line summary of a clean run, so a
reader can tell "nobody has written one" from "somebody decided against one"
wherever they meet it.

**A waiver is a decision, recorded by whoever wrote the pull request body,
and that includes a contributor from a fork.** On the ordinary path, where a
repository has no frozen contract of its own, `Spec: none` means the intent
gate does not run at all on that pull request, and budget breaches are the
thing this gate blocks on. The one thing a waiver cannot override is a frozen
native contract, under either of the two paths above, which is checked first:
a repository that wants the gate to be non-waivable freezes a native contract
and keeps it committed.

**What blocks is unchanged.** Blocking stays where intent-guard puts it:
budget breaches block, subject to `enforce`. Drift on its own is reported and
not blocked, which is already intent-guard's own behaviour. The umbrella adds
no severity threshold of its own here either.

## The Action

`action.yml` at the root is a composite action that runs the gates at the
`ci` stage and writes one SARIF log for the caller to upload.

It **installs all four packages itself**, and outside the workspace. Until
0.4.0 it installed nothing and ran the `node_modules/.bin/conductor` your
repository already had, which put every program in the family inside the tree
under judgment: the install step runs the head's lockfile, so a pull request
could repoint any gate, or the umbrella itself, at a build it controls while
leaving the version number alone.

Now four inputs name exact versions, `conductor-version`,
`dep-guard-version`, `vault-guard-version` and `intent-guard-version`, each
defaulting to the version this release pins. A validate step refuses anything
that is not an exact version, a range and `latest` included: the version that
judges a pull request has to be a decision taken on the base branch rather
than one the registry takes on the morning of the run. An install step then
runs `npm install -g --ignore-scripts` under the runner temp, never into the
workspace, and prepends that bin directory to `PATH`, so the run step invokes
`conductor` off `PATH` and each gate resolves by name the same way. The install
is **unconditional**, on push and `pull_request` alike, so there is one code
path rather than one that matters and one that nobody exercises.

**On a pull request those four inputs may not pin backward.** The shape check
asks whether an input is an exact version; it says nothing about which one, and
on a `pull_request` event the workflow file comes from the head, so the pins are
written by the pull request being judged. Once a gate has two published versions
that is a bypass with an innocent shape: pin back to the release that predates
the rule which would have caught the change, and the change picks the rules it
is judged by. So where `GITHUB_BASE_REF` is set, the validate step refuses an
input naming a version below the one the action tag ships, naming both numbers,
and the fix is to **remove the input**: the default is that version. Pinning
**forward** is still accepted, on an assumption the rule does not enforce, that
a newer gate is at least as strict; nothing bounds how far forward you pin.

Three things follow from that, stated because the summary is wider than the rule.
It fires on fork pull requests too, where the base repository's workflow file is
the one that runs, so a deliberate backward pin you wrote yourself will refuse
every fork run until you remove it. Push runs are out of scope rather than safe:
a push to an unprotected branch runs that branch's own workflow file, written by
the same author. And `merge_group` runs are not covered at all: `GITHUB_BASE_REF`
is set on `pull_request` and `pull_request_target` only, so it is empty in a
merge queue even though the queue branch carries the pull request's commits and
its workflow file. If your only required check runs on `merge_group`, this rule
does nothing for you; keep the `pull_request` run required as well and the pin is
caught before the queue. Neither this nor anything else in `action.yml`
replaces branch protection with review required for `.github/workflows`, which
is still the only control over a pull request that edits the workflow.

`--ignore-scripts` is there because the step holds the job's token and the four
things it installs decide whether a pull request may merge; without it every
package in the resolved tree would run code on the runner. The step then runs
`npm audit signatures` over what it installed.

**What that verification proves, and what it does not.** It asks the registry
for each name and version in the tree, the four gates included, and checks the
signature served back, so an unpublished, replaced or unsigned package fails the
step. It does **not** read the installed files, so it will not detect a tampered
install; it does **not** defeat a compromised registry, which signs what it
serves; and a **missing** attestation is not a failure, so it does not require
provenance even though all four packages publish it.

> **This step needs a registry that serves `/-/npm/v1/keys`.** If your runner
> points npm at a mirror or proxy that does not (via `actions/setup-node`'s
> `registry-url:`, a corporate `~/.npmrc`, or `npm_config_registry`), the
> install succeeds and this step then fails with `EMISSINGSIGNATUREKEY`. A
> sigstore outage has the same effect. It fails closed on purpose, so that is a
> red gate rather than a skipped check; pin to `@v0.4.0`, which does not
> verify, if it blocks you.

`--base` is passed only when the `base-ref` input names one; left empty, the
umbrella reads `GITHUB_BASE_REF` itself and treats an empty value as "not a
pull request", which is what a push build wants.

On a `pull_request` event the action passes
**`--trust-base origin/$GITHUB_BASE_REF`** of its own accord, so the run takes
its configuration from the base branch and the pull request cannot change the
rules it is judged by; a change to the rules shows as a proposal line and
takes effect after merge. See "The pull-request trust boundary" above. On any
other event it passes nothing and behaviour is unchanged. The `trust-base`
input names the ref explicitly, for a platform where `GITHUB_BASE_REF` is not
set.

There is deliberately **no input that turns pull-request mode off**.
Base-ref judging is the floor rather than a knob, and on a `pull_request`
event the workflow file itself runs from the pull request's own ref, so an
opt-out here would be settable by the very pull request the mode exists to
judge: the knob and the thing it protects against would be the same file.

```yaml
name: guardrails
on: pull_request

jobs:
  gates:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
        with:
          # Required, for two reasons now. Without it there is no merge base
          # to diff against, and the intent gate fails closed rather than
          # checking an empty set. And the base ref itself has to be in the
          # clone, because on a pull request the rules are read from it: a
          # base ref that will not resolve is exit 2 for every enabled gate.
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          # Not a bare major: Node 22.0.0 ships npm 10.5.1, which the action
          # refuses because that client reports a clean install as tampered
          # with. 22.1.0 or later, or 20.13.0 or later, carries an npm that
          # can verify.
          node-version: '22.11.0'
          cache: pnpm
      # Your own dependencies. The gates are NOT among the things this has to
      # install: the action installs those itself, globally, at the versions
      # pinned below.
      - run: pnpm install --frozen-lockfile
      - id: conductor
        uses: ./
        with:
          output: conductor.sarif
          # Exact versions, never a range and never "latest". These four
          # lines decide which programs judge a pull request, so a pull
          # request's own lockfile no longer does. They are only as protected
          # as this file is: require review on .github/workflows in your
          # branch protection. Bump them like any other pin, in a pull
          # request of their own. Forward only on a pull request: the action
          # refuses a pin below what its tag ships, and the four lines can be
          # left out entirely to take that tag's own versions.
          conductor-version: 0.4.0
          dep-guard-version: 0.7.0
          vault-guard-version: 1.8.0
          intent-guard-version: 1.5.2
      - uses: github/codeql-action/upload-sarif@v3
        # Always: the log is most worth having on the run that failed.
        if: always()
        # The sarif path is published BEFORE the gates run, so on the exit 2
        # cases that fail before anything is written (a policy error, an
        # unknown stage, an unwritable output path) it names a file that was
        # never created. Publishing early is the right trade for the common
        # case, which is exit 1 with a real log; this step just has to
        # tolerate the file being missing rather than failing the job a second
        # time over it.
        continue-on-error: true
        with:
          sarif_file: ${{ steps.conductor.outputs.sarif }}
```

The `@v4` pins there are readable, not safe: a tag moves, so pinning by one
runs whatever its author pushes to it next. Pin every third-party action by
commit digest in a workflow you actually run, the way this repository's own
workflows do.

### The report as a pull request comment

**Built in, opt-in.** This matters most for an advisory job: a `pull_request`
check that is not marked required does not block anything when it fails, and
without a comment its findings live only in the job's exit code and log,
which teaches a developer nothing. Set `pr-comment: true` on the Action's own
step and add `pull-requests: write` to the job's `permissions`:

```yaml
    permissions:
      contents: read
      security-events: write
      pull-requests: write
    steps:
      # ... checkout, pnpm, setup-node, install, as in the example above ...
      - id: conductor
        uses: ./
        with:
          output: conductor.sarif
          pr-comment: true
```

That posts conductor's own text report, the one the README quotes above
("conductor: clean, nothing blocked. 2 gate(s) ran: ..."), as a comment on
the pull request. It is **sticky**: a hidden marker in the comment body lets
a re-run find and update that same comment, so a push does not pile up a new
comment every time, the way the manual recipe below does. It runs on a
`pull_request` or `pull_request_target` event only, and it runs whether the
gates step passed or failed, since a blocking run is the one an advisory
check most needs a developer to actually see.

**It is a no-op on a pull request from a fork.** The default `GITHUB_TOKEN`
there is read-only regardless of the `pull-requests: write` permission you
grant, so the post fails; the step catches that, prints a `::warning::`
naming the likely cause, and continues. The gate's own pass/fail is decided
entirely by the earlier "Run the gates" step and never depends on whether
the comment posted, on a fork or anywhere else. `pull_request_target` runs
with a writable token and the base repository's own workflow instead, which
is a different security decision to take on purpose rather than a flag to
add; nothing here does that for you.

Off by default, so an existing consumer of this action is unaffected.

**The sticky match only ever adopts conductor's own comment.** On
`pull_request_target` this step runs with a write token even though the
pull request itself is untrusted, so anyone who can comment on the pull
request could, in principle, author a comment carrying the same hidden
marker before conductor's first run. The match requires the marker AND that
the comment was authored by the GitHub Actions bot; a marker in anyone
else's comment is never adopted, and conductor creates its own comment
instead, exactly as if no marked comment existed.

**Running this Action more than once against the same pull request** (for
example, once per package in a monorepo) needs its own marker per run, or
those runs fight over one shared comment. Set `pr-comment-marker` to a
distinct string per invocation and each run stays sticky to its own
comment; left unset (the default), every invocation uses the same built-in
marker, which is the existing, unchanged behaviour for a single invocation
per pull request.

```yaml
      - id: conductor-package-a
        uses: ./
        with:
          pr-comment: true
          pr-comment-marker: 'package-a'
      - id: conductor-package-b
        uses: ./
        with:
          pr-comment: true
          pr-comment-marker: 'package-b'
```

**A note for anyone changing this surface, not for a consumer of the
Action**: the comment body reaches `gh` with `-F body=@<file>` (`gh api`'s
file-read form), never `-f`, which sends the value as a literal string
instead of reading the file. The offline test suite
(`scripts/tests/pr-comment.test.mjs`, `scripts/tests/pr-comment-cli.test.mjs`)
replaces `gh` with a recorder or a shim, and neither can tell `-f` from `-F`
apart, since both simply accept a `key=value` string and neither actually
reads the `@file` form. `scripts/tests/pr-comment-smoke.test.mjs` is what
actually proves the distinction, against a real `gh` binary; it is skipped
by an ordinary offline `pnpm test` run and only runs with `GH_TOKEN` (or
`GITHUB_TOKEN`), `CONDUCTOR_PR_COMMENT_SMOKE_REPO`, and
`CONDUCTOR_PR_COMMENT_SMOKE_ISSUE` set. Run it for real against a scratch
issue or pull request before any release that touches
`scripts/lib/pr-comment.mjs` or `scripts/pr-comment.mjs`; the file itself
documents the exact invocation.

**The manual recipe below still has a reason to exist**: a non-sticky
comment (one per run, never edited), a report you want to post yourself with
different formatting, or a workflow that would rather not add
`pull-requests: write` to the same job the gates run in. For the common
case, `pr-comment: true` is the built-in answer.

The SARIF upload produces no alerts on a private repository without GitHub
Code Security, which is why that step carries `continue-on-error`. A comment
is free there. Add `pull-requests: write` to the job's `permissions` and this
step after the gates. It **runs the gates a second time**, because the Action
writes SARIF and nothing else, so the job costs roughly twice the gate time;
`--verbose` because a clean run otherwise collapses to one line.

```yaml
      - name: Comment the report on the pull request
        # always: the report is most worth reading on the run that failed,
        # and the gates step has already failed the job by then.
        if: always()
        continue-on-error: true
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
          # The same derivation the Action makes for its own --trust-base.
          # github.base_ref is a BRANCH NAME and is empty outside a pull
          # request, so an empty value has to mean "not a pull request":
          # passing --trust-base unconditionally would hand a push build the
          # literal ref "origin/" and fail it closed.
          BASE: ${{ github.base_ref }}
        # || true: a blocking finding is a non-zero exit, and that verdict
        # belongs to the gates step rather than to this one.
        run: |
          ARGS=(run --stage ci --format text --verbose --output conductor.txt)
          if [ -n "$BASE" ]; then
            ARGS+=(--trust-base "origin/$BASE")
          fi
          conductor "${ARGS[@]}" || true
          gh pr comment "$PR" --body-file conductor.txt
```

`conductor` and not `node_modules/.bin/conductor`: the gates step put the
installed one on `PATH`. Reaching into `node_modules` here would report a
different program's verdict from the one in the uploaded log.

`--trust-base` for the same reason, and the two together are what make this
the run the uploaded log is about: same binary AND same trust base. Without
it this second run reads the head's own policy file, consults
`node_modules/.bin` like any local run, and never asks where a gate's program
came from, so a pull request that plants one gets a clean comment beside a
SARIF log that refused it.

**Mirror whatever you gave the Action**, or the two runs can report different
contracts. The step above matches the example, which passes neither
`base-ref`, `trust-base` nor `spec`, so both runs read `GITHUB_BASE_REF` and
the `Spec:` line out of the job environment themselves and land on the same
contract and the same ref. If you set any of those inputs on the gates step,
pass the same values here as `--base`, `--trust-base` and `--spec`; if you do
not, the comment is a report of a contract source, or of a boundary, the
uploaded log never used.

**On a pull request from a fork the token is read-only**, so `gh pr comment`
fails, `continue-on-error` swallows the failure, and no comment appears on
exactly the pull requests a reviewer knows least about. Nothing here fixes
that: `pull_request_target` runs with a writable token and the base
repository's own workflow, which is a different security decision to take on
purpose rather than a flag to add.

This is a substitute for code-scanning alerts, not the same thing. A comment
is one snapshot of one run: no per-finding state, nothing to dismiss, no
history between runs, and a new comment every time rather than an alert that
closes when the finding goes away.

## What is in and what is out

In: the policy file and its schema, `init` with dry-run, revert, and adopt,
`run` producing the combined text report and a combined SARIF log, the
composed exit code, per-gate `stage` and `enforce`, `run --stage`, the intent
gate at a pull request (`--base`, `--spec`, the imported contract, the
no-contract advisory), and the composite Action.

Out, deliberately: a unified baseline or ledger (each gate keeps its own, and
their fingerprints are not equally durable, so one shared file would expire
entries silently for one product and not another), an MCP registration,
running the gates concurrently, and any finding of the umbrella's own about
anybody's CODE. The findings it does raise are all about the gates
themselves: `conductor/gate-missing`, `conductor/gate-output-unparseable`
and `conductor/gate-failed`, plus the two diagnostics
`conductor/blocking-count-mismatch` and
`conductor/blocking-threshold-unknown`.

Also out: intent at the cohesion level, which is what a merge or a
promotion would want and which the audits do by hand today; and anything that
runs inside an agent session or on save, which intent-guard's own optional
session hooks already cover.

This is a young tool rather than a finished one. The gates are still the
product; this is the convenience layer over them.

## Design notes

The reasoning behind the decisions above lives in
[docs/design-notes.md](docs/design-notes.md): the digest ladder that lets a
re-install replace an older hook, how husky and lefthook are recognised and
why one of them is refused, what the hook says on each exit code, why a clean
report collapses to one line, the rule separating a SARIF notification from a
SARIF result, how the exit code is composed, and the mechanism behind the
intent gate at a pull request. Several of them were learned from running this
tool against real repositories rather than reasoned out in advance.

## License

MIT, [Vault & Compass](https://vaultcompass.io)
