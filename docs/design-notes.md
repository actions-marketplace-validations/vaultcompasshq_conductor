# Design notes

These are the reasons behind decisions the README states, kept in the words
they were first written in rather than summarised. Several of them were
learned from real incidents, from running this tool against real repositories
and finding it wrong, which is why they are written down at all.

## The policy file

### Why defaults are written out

`stage` and `enforce` are both written out for every gate, with their
default values, because a default that lives only in the parser is a default
nobody can find. `enforce` is the one exception to "the written value is the
default": the intent gate starts at `false`, so a fresh init produces the
adoption ramp rather than describing it and leaving somebody to hand-edit it
in.

### Why gates are keyed by role

This is worth one extra line: it makes a product rename a one-line edit rather
than a rename of the key your CI reads, and it leaves room for a fourth role
to arrive without the schema moving.

### Why a missing binary is a finding

A gate that is switched on and quietly absent is the failure this whole family
exists to prevent.

### Why the stage defaults fall where they do

Runtime is not what decides that split. All three gates together take under
a second on a staged commit. Ceremony is the cost, and only the intent gate
has any: it wants a contract approved before the work starts, which is a
per-task human step and belongs at a pull request. The other two are silent
until they find something, and a secret that reaches a pull request is
already on a remote, so the earliest stage is the only honest place for
them.

### Why a deferred gate gets no SARIF run

It gets no SARIF run of its own, for the same reason a gate that could not run
gets none: it produced no tool output, and an empty run named for that product
would put its name on something it never did.

That rule is written for a gate that never ran, and it currently also covers
a gate that ran and failed. The SARIF-native shape for the second is its own
run with `invocations[0].executionSuccessful: false`; that is not done yet,
because it changes the run list of every log with a failing gate in it. What
follows from leaving it is that `conductor/gate-failed` in the umbrella's run
is the only place such a log can say anything about the failure, so that
finding carries the failing gate's own stderr, trimmed, capped and truncated
out loud rather than silently. It used to carry only "the gate exited 2,
which it uses for could not run", which a reader with the log and nothing
else cannot act on: a dogfood run had dep-guard naming an unparseable
lockfile in the text report and saying nothing in the log beside it.

### What `enforce: false` does not quieten

The failure is not quietened down anywhere else. In SARIF it is still a
`conductor/gate-missing` or `conductor/gate-failed` result at `error` level,
because a class of problem went unlooked-for on this change whoever was
enforcing the gate. What records that the verdict never reached the exit code
is the `conductor/gate-not-enforced` notification, and in the text report the
line under that gate's section.

It is not a downgrade of what the gate said. Findings keep their own
severities and their own `blocking` flags, in both formats, because
rewriting a critical finding to a note would put this repository's
enforcement policy into the field a code-scanning UI uses to describe the
finding itself. What changes is that the text report says in words that the
gate blocked and was not enforced, on the same screen as the findings, so a
green exit next to red findings is never a surprise. In SARIF that gate's
own run carries `properties.enforced: false`, and the `conductor` run
carries a `conductor/gate-not-enforced` notification as well, because a gate
that could not run has no run of its own to hang the property on and that is
exactly the case worth saying out loud. That run's properties bag also
carries the `stage` the gate ran at, so a log from a commit-stage run is
distinguishable from a full one rather than looking like the same run with
fewer findings in it.

### Why `options` is passed through uninterpreted

Nothing here interprets any of them, which is why a gate can grow a flag
without this package needing a release.

### Why there is no shared severity threshold

Two of the three products share a four-level scale exactly; the third scores a
weighted rubric from 0 to 100 and has two budget outcomes with no severity in
them at all.

### How a gate's binary is resolved

Otherwise resolution tries each of that product's binary names in order,
looking in the repository's `node_modules/.bin` and then on `PATH`. The
repository's own copy wins, so a project pin beats a global install, which
is what `pnpm exec` does in the same repository. The name is the outer
loop and the location the inner one, so a product's current name still
wins over an older one wherever each is installed: a repository has no say
in which product a name means, and every say in which build of it to run.

### Precedence

1. the gate's own config file, which the umbrella never reads or writes;
2. this policy file, delivered to the gate as command-line flags;
3. a flag on the umbrella's own command line.

Layer three is narrow on purpose. `--gate <role>` restricts a run to named
roles; `--stage`, `--base` and `--spec` change what a run measures; `--format`,
`--output` and `--verbose` change how it is reported. There is no umbrella flag
that rewrites a gate's threshold, for the reason above.

### Why an excluded gate is named in the report

Without those lines an uploaded log from a narrowed run cannot be told from a
log of a full one, which is the same confusion the deferred notification
exists to prevent.

## Re-installing over an older hook

Re-running init over a hook a **previous version of conductor** wrote
replaces it, rather than reporting it already installed. The marker in the
hook says whose it is, not which version, so the decision is the hook's
digest: identical to what this version writes means nothing to do;
identical to the digest the manifest recorded means an older conductor
wrote it and it is updated in place; anything else means it has been edited
by hand, and it is refused with the same guidance a changed file gets under
`--revert`. A marked hook with no manifest to check against is treated as
edited. Skipping an old hook left it running a command line this version no
longer writes, and left it out of the new manifest, so a later `--revert`
walked past it.

The manifest is rebuilt when it is the part that has gone missing. A hook
that is already byte for byte what this version writes, in a repository
whose manifest no longer records it, is left alone on disk and entered in
the manifest. Nothing is written to the hook, because nothing is wrong with
it; without the entry, `--revert` has no record that the hook is the
umbrella's, reports success, and leaves it running. A `git clean`, a
deleted `.guardrails` directory, and an install from before there were
manifests all reach that state.

A revert that cannot remove everything removes nothing that would leave the
repository half-wired, keeps the manifest describing what is left, and
exits non-zero. In particular, if the hook has been edited by hand it is
left alone and so is the policy file, because a hook running the umbrella
with no policy file to read would refuse every commit.

Changing the hook body turns every hook a previous conductor wrote into one
"from an older conductor", which is the case init already handles by digest:
it rewrites the body in place and records the new digest. Nothing has to be
reverted and reinstalled by hand.

## The hook

One hook, running `conductor run --staged --stage commit`. It names the
stage rather than running everything, because a pre-commit hook is the
commit stopping point, and a hook that runs the per-task ceremony of the
intent gate on every commit is a hook a team switches off. It fails closed:
a missing umbrella binary blocks the commit with one line saying so, because
a guardrail that is off when the tool is missing is a guardrail an attacker
turns off by making the tool missing. It passes the exit code straight
through, so 2 does not collapse into 1 and report findings that were never
looked for.

**It says a different thing for each of those two codes.** On exit 1 a gate
blocked, and the line points at the report and says that disagreeing with a
finding is done in `.guardrails.yaml` or in that gate's own configuration, so
the decision is recorded where the next reader can see it. On exit 2 nothing
was checked at all, and the line says that rather than calling it a blocked
commit: a gate that could not run made no decision, and reporting one is the
same error as collapsing the codes. That line says "if there is a report
above" rather than "the report above", because the same branch catches an
umbrella that crashed or was never executable, and exit 127 with no output
at all is one of the shapes that reaches it.

**Neither line advertises a bypass.** Every gate already has a recorded,
scoped escape: an allow entry, an ignore path, a baseline, or
`enforce: false`. Skipping the hook skips every gate invisibly, including
the ones that would have caught something unrelated to the finding
somebody disagreed with, and leaves no trace of the decision anywhere.

The hook prepends the repository's own `node_modules/.bin` to `PATH`
before looking for the binary, so a conductor installed only as a project
devDependency is visible to its own hook. The root comes from
`git rev-parse --show-toplevel` rather than from the working directory,
because a hook invoked from a subdirectory would otherwise prepend a path
that does not exist. Fail-closed is unchanged: no conductor there and none
on `PATH` still blocks the commit. The hook also survives being run under
`sh -e`, which is what husky's dispatcher does, so the line explaining a
blocked commit is printed there too rather than being cut off by the
shell.

## Hook managers

Two of the three gates write a marker comment into the hook they install,
so init recognises those exactly. The secret scanner writes no marker, so
its hook is recognised **by content**: a hook that mentions that tool and
runs a staged scan. That is the same test its own installer applies to its
own hook, but it is a heuristic, and a hand-written hook that happens to
call that tool the same way will be treated as its. Read what `--dry-run`
reports before running `--adopt` on a hook you did not write.

A relative `core.hooksPath` is resolved against the working-tree root,
which is where git actually looks. An absolute one pointing outside the
repository is refused rather than written to, since that directory serves
every repository on the machine.

**Where git looks is not always the file to write.** husky 9 points
`core.hooksPath` at `.husky/_`, a generated and gitignored directory it
rewrites on every install; the file git executes there is a dispatcher
that adds `node_modules/.bin` to `PATH` and runs the tracked hook one
directory up. Init recognises that arrangement and then reads, detects,
adopts, writes and reverts `.husky/pre-commit`, never anything under
`.husky/_`. Reading the dispatcher instead reports the repository's real
gate hook as foreign, so `--adopt` cannot adopt it, and writing the
dispatcher puts the hook where the next install deletes it without saying
so. Both were found by running this tool against a real husky 9
repository rather than against a fixture.

Recognition is structural: the hooks directory is named `_` and its parent
is named `.husky`. Only husky creates that path, so the shape alone
identifies it, and two things that look like useful corroboration are
deliberately excluded.

The **contents** of the file git executes are not a signal, because under
husky 8 that file is the tracked hook itself: husky 8 points
`core.hooksPath` at `.husky`, and every tracked hook there opens by
sourcing `_/husky.sh` as a preamble. Reading that preamble as a dispatcher
sends init one directory above `.husky`, which is the repository root.
husky 8 therefore takes the ordinary path, where `.husky/pre-commit` is
already both the file git runs and the file init reads.

The **presence of husky's shim** is not a signal either. husky gitignores
`.husky/_`, so `git clean -xdf` deletes that directory while
`core.hooksPath=.husky/_` sits in `.git/config` and survives. A repository
in that state has no shim and no dispatcher to find, and requiring one
would send init back to writing `.husky/_/pre-commit`, the very file the
next install wipes. The shim says whether husky ran recently, not whose
directory this is, so `--dry-run` reports it and the rule ignores it.

lefthook and the pre-commit framework also install a generated script
where git looks, and neither has a tracked counterpart to write instead,
so both are recognised and refused with a pointer at the manager's own
config file (`lefthook-local.yml`, `.pre-commit-config.yaml`). A gate run
from either of those is subject to that manager's exit code rather than
the umbrella's, so 1 and 2 stop meaning different things there; that is
why init names the file rather than editing it.

simple-git-hooks and yorkie are the same refusal with one difference that
changes how they have to be found: their hook text lives in a declaration
elsewhere rather than in a config file the generated hook points at, so the
declaration exists on a fresh clone where the generated hook does not, and
reading only the hook file misses exactly the repository somebody is most
likely to run init in. Either signal alone is enough, and the declaration is
not corroboration: simple-git-hooks 2.8.0 writes a hook containing nothing
but the shebang and the user's command, so no content rule can recognise it
at all.

The declaration is the `simple-git-hooks` or `gitHooks` key in package.json,
and for simple-git-hooks also any of the standalone config files its own
README lists (`.simple-git-hooks.cjs`, `.simple-git-hooks.js`,
`.simple-git-hooks.mjs`, `.simple-git-hooks.json`, and
`simple-git-hooks.{cjs,js,mjs,json}`). That list is exact rather than a
prefix test, so a `simple-git-hooks.yaml` is what it looks like, somebody's
notes, and not a reason to refuse an install. The combination that needs all
three signals is real: a standalone config plus a version old enough to write
no marker is invisible to both of the others.

**The refusal fires only where git actually runs `.git/hooks`.** Both
managers write that directory and neither reads `core.hooksPath`, so under
husky, or under any other configured hooks directory, the file they rewrite
is not the file git runs. Refusing there would name a file the manager never
touches and block an install that is perfectly safe. The test is whether the
resolved hooks directory IS the git directory's own `hooks/`, compared
through `realpath` rather than by asking whether `core.hooksPath` is set: a
repository may set it to exactly where git already looks, and that is a no-op
git treats identically.

The refusal points at the entry to edit rather than offering to edit it,
because init writes a hook, a policy file and a manifest, and the manifest is
what makes `--revert` honest: a merge into somebody's package.json has no
revert story that is not a guess about which later edits were theirs. The
guidance says to put the umbrella last and as its own command, never chained
behind `&&`, because a chain stops at the first failure: an umbrella in front
hides the other command's verdict, and one behind an `&&` never runs at all
once anything ahead of it fails.

## The report

The line names the gates that ran, names any gate deferred to a later stage
or left with nothing to check, names any gate that ran with `enforce: false`
and so could not have blocked anything, counts any notes, and says to re-run
with `--verbose` for the rest.

Clean means all four of: the composed exit code is 0, no gate blocked, no
gate could not run, and the umbrella raised no diagnostic of its own. The
last three are not implied by the first. A gate with `enforce: false` is left
out of the composed code entirely, so one that blocked, or one that could not
run at all, still leaves the run at exit 0, and those are exactly the runs
whose report must not be collapsed to a line. A run where no gate ran at all
prints the full report too, so the distinct verdicts for "none is enabled",
"every gate was deferred" and "nothing had a contract to check" survive.

**A gate's own notes are counted; the umbrella's own diagnostics force the
full report.** The same rule separates them as separates a SARIF notification
from a SARIF result. A gate's note is a statement about how much a run
covered, such as pnpm lockfiles not recording install-script metadata, which
is a permanent property of that file format and true on every run forever. A
`conductor/blocking-count-mismatch`, or a `conductor/blocking-threshold-unknown`,
is the umbrella saying its own report may disagree with the gate's own verdict
about what blocked, which is a defect in this run and cannot honestly be a
number on a line that also says "clean, nothing blocked".

This is a text-format decision and nothing else. The SARIF log is unchanged
either way, and there is deliberately no policy key for it: the schema
describes what a repository gates on, and how loud one developer wants their
own terminal to be is not that.

The full text report is one section per gate, blocking findings first, with each
gate's own threshold, its own suppressed and ignored counts, and its own
exit code and duration in the header. The counts are printed even at zero,
because they are the user's earlier decisions and hiding them makes a
repository with two hundred baselined findings read as clean.

## SARIF

The SARIF output is one log with one run per gate, each run's tool name and
version taken from that gate. Rule ids are product-namespaced, each result
carries the gate's own fingerprint verbatim in `partialFingerprints` under
a key naming the product, and the properties bag carries `blocking`,
`severity`, whether that severity was assigned by the umbrella rather than
by the gate, how durable that fingerprint is, and the gate's own details
bag with its values unchanged. A value in that bag is never converted, so
where a gate's own units differ from SARIF's the key says so:
`columnZeroBased` is the secret scanner's own 0-based column, sitting
beside the 1-based `startColumn` mapped from it. No location is invented:
a finding with no known line gets no region, and a finding about a missing
binary gets no location at all.

**A statement about coverage or configuration is a notification, not a
finding.** Three of the umbrella's own statements are about how much of the
policy a run represents rather than about anybody's code: a gate deferred to
a later stage, a gate the policy told not to decide anything, and a branch
with no contract for the intent gate to check against. They live in
`invocations[0].toolExecutionNotifications` on the `conductor` run, keeping
their rule ids as descriptor ids and their text unchanged. As results they
were fingerprint-less note alerts that came back on every single run, so a
repository on the adoption ramp accrued permanent alerts about the tool's own
configuration, which is alert fatigue manufactured by the thing that exists
to reduce it.

The rule that decides which is which, so the next case does not go to
judgment: **a statement about how much of the policy a run covered is a
notification, and a statement that something went wrong is a result.** The
first is true of the configuration rather than of the change, identical on
every run until somebody edits the policy file, and on the adoption ramp
deliberately true for weeks; a permanent alert is a dismissed alert. The
second is about this run, goes away when somebody fixes it, and the reviewer
of this change is the person who should see it.

So `conductor/gate-missing` and `conductor/gate-failed` stay **results**: a
gate that could not run is the fail-closed posture made visible, a class of
problem went unlooked-for on this change, and a reviewer scanning a pull
request's alerts has to meet that as an alert rather than as tool status. The
normalization diagnostics stay results for the same reason. That rule also
decides the text report's summary line, and the two answer it the same way.

## Exit code composition

A gate carrying `enforce: false` is left out of that composition entirely,
and a gate the stage filter deferred never gets as far as it. Both are the
policy file's own decisions, written down in the repository; nothing here
reads a gate's output and decides on its own to ignore it.

This is not the numeric maximum of the children's exit codes, because the
codes do not mean the same thing in each product. One of the three uses 2
for "could not run the checks at all"; the other two have only 0 and 1 and
use 1 both for a real finding and for a broken config. So the composed code
can differ from the maximum of its children's, and a gate that could not
run outranks a gate that blocked. A report that reads clean because nothing
looked is worse than one that says it failed.

## Intent at a pull request

### Why the diff is three-dot

The three-dot form is the point: two-dot would attribute every commit that
landed on the base branch after this branch forked to this branch, so somebody
else's merge would breach this pull request's change budget. A rename lists
both its old and its new path, so moving a file out of a protected directory
still blocks; the cost is that a rename counts as two paths against
`max_files`.

### Why a spec named in a pull request body is the weakest claim

Written by whoever opened the pull request, which is a weaker claim, so a path
here that is not on disk falls through to the next rule: a typo in a
description must not fail a build. A path that leaves the repository falls
through the same way, because on a fork pull request that body is written by
somebody with no write access, and an unchecked `../` there imports an
arbitrary readable file from the runner and puts its path in the contract.
`--spec` is deliberately not held to that rule: a person typed it, and a spec
kept outside the checkout is a real thing to want.

### How several candidate specs are ranked

Several candidates are ranked: a stem **equal** to the slug first, then the
**longest** stem, and only then the newest name. Newest alone was the rule,
and it put a pull request against another feature's requirements: a vaguer
spec carrying a later date beat the one named for the branch.

The newest-name tie-break is still a lexical one, so **date every spec**.
Where two names reduce to the same stem and one has no `YYYY-MM-DD-`
prefix, the undated one sorts last and wins. That is a different revision
of the right feature's spec rather than a different feature's, which is
why the ranking leaves it alone, but it is not necessarily the revision
you meant.

The plan under `docs/superpowers/plans` is paired only when its stem is
**equal** to the chosen spec's, and passed as `--plan`. Equal rather than
related, because pairing a spec with a neighbouring feature's plan freezes
one set of requirements against the other's change budget, and the block
or pass that follows is about neither. No plan is fine; intent-guard
imports a spec on its own.

### How the contract is frozen

`intent-guard import-spec --from superpowers --dry-run` drafts a contract,
that YAML is written into a **temporary** directory, `intent-guard freeze`
approves it there with an `--approved-by` naming the spec and the short
commit, and the gate runs with `--project` pointed at that directory. Nothing
is ever written under the repository's own state directory, under either of
its names: a contract is a committed artifact with an approver's name on it,
and one dropped into a working tree by a CI run is either committed by
accident or read by the next run as though a person had approved it. Any
failure in that chain is could-not-run for the gate, and the report names the
step it failed at, because the gate itself said nothing and that sentence is
all there is to tell a shallow checkout from a spec the importer choked on.

### The state directory has two names, and the umbrella reads both

intent-guard 1.3.0 renamed its per-project state directory from `.conductor`
to `.intent-guard`, because `.conductor` had become the name of a different
product in the same family: a repository adopting both showed `.conductor/`
and `.guardrails/` side by side with nothing to say which tool owned which.
Both versions will be installed across repositories for as long as anybody is
slow to upgrade, so the umbrella looks in both, canonical first. A gate whose
contract the umbrella cannot find is a pull request blocked on nothing.

Three decisions sit under that, and each cost a paragraph of thought.

**The conflict test is exactly intent-guard's own, and an earlier version of
it was not.** The rule is: the canonical directory merely existing, even
empty, beside a legacy directory holding any of the gate's own state markers
(`config.yaml`, `intent-contract.yaml`, `index.md`, `drift-log.jsonl`,
`contracts`), frozen or not. In that state the gate is could-not-run, naming
both directories.

The first version of this was narrower -- both directories holding a
**frozen** contract -- and the argument for it sounded good: a stale unfrozen
draft beside a real contract has an obvious right answer, and refusing would
fail pull requests over a file nobody has looked at in months. The argument
was about the wrong tool. In that exact state the gate's own `stateDir`
throws and every intent-guard command exits 1, so the narrower rule saved
none of those pull requests. It moved where they broke: conductor handed the
gate a repository the gate refuses to run in, the child exited non-zero with
no JSON, and the run surfaced as `gate-output-unparseable` with a message
about the umbrella being out of date with the gate. Reasoning about what
another tool ought to do is not evidence about what it does.

A `.conductor` holding none of those markers belongs to something else,
and neither tool touches it. The check sits **above** `--spec`, because the
import path runs `import-spec --project .` in that same repository, where the
gate fails closed on the same conflict and reports it as an opaque non-zero
exit. The guidance says to move the old directory aside and never to delete
it, because conductor has not read what else is in there.

**The drafted contract is written under the legacy name**, into the temporary
directory. That is the one choice that works on both versions: a 1.2.x gate
reads only `.conductor/`, and a 1.3.0 gate reads it as the fallback and
renames it to the canonical name on its first write, which the freeze is.
Writing the canonical name would work on 1.3.0 and leave 1.2.x freezing an
empty project. After the freeze the contract is looked for under both names
and a preparation failure is raised when it is under neither, because exit 0
is not by itself proof there is a contract to hand the gate.

**Reading the old directory is a notification, not a result.** It is the
closest call among the five notifications and worth stating: nothing went
wrong, the gate ran, and the verdict is exactly what it will be after the
migration. What the line says is which of two layouts the run covered, and it
stays true on every run until somebody upgrades the gate, so as a result it
would be a fingerprint-less alert reappearing on every pull request for as
long as that takes.

### Which budget applies

**Which budget applies** is intent-guard's rule, not this package's, and it
is worth knowing before you write one: the importer takes the **first** fenced
`yaml` block whose whole content is a single `budget` key, searching the
**spec first** and the plan only after it. So a budget in the spec wins, and a
budget in the plan applies only when the spec has none. Putting one in each
is not a merge; the plan's is simply never read.

### What the reports say about the verdict

Both reports say what the verdict is about. The text report carries one line
naming the contract source and the base ref; the gate's SARIF run carries
`contractSource` and `baseRef` in its properties bag, beside `enforced` and
`stage`.

## The Action

`output` is relative to `working-directory`, and the `sarif` output reports
it relative to the **workspace**, which is where the caller's upload step
runs. It is published before the gates run, because the log is most worth
having on the run that failed.

`continue-on-error` there hides nothing: a gate that blocked has already
failed the job through `conductor`'s own exit code, before this step runs.

The intent gate starts at `enforce: false`, which is what `init` writes, so a
repository reads a few pull requests' worth of drift before letting it refuse
anybody's merge:

```yaml
gates:
  intent:
    product: intent-guard
    stage: ci
    enforce: false
```

### Why a failed signature check must say so

Learned from an incident on 2026-09-22. An adopter's gate posted a red check
having scanned nothing, for two days, and the only visible symptom was
`conductor: command not found`.

What happened: `npm audit signatures` failed on one package. The install step
runs under `set -eu`, so it died there, and the line that puts the install on
`PATH` came *after* the audit. The gates step was skipped. The comment step
runs `if: always()`, so it ran anyway, tried a second `conductor` invocation to
render its text, found no binary, swallowed that with its deliberate
`|| true`, and posted a comment rendered from an empty file. The job concluded
success. Only the check-run concluded failure.

Three separately correct mechanisms composed into silence. Failing closed on a
signature check is right. Running the comment step on a failed run is right.
Not letting the comment step's render invocation change the verdict is right.
Together they produced a gate that scanned nothing and said nothing about why.

The package was never at fault. Its artifact was byte-identical to what its
attestation covered, it was published by CI rather than by hand, and the same
verification succeeded on a re-run of the identical commit an hour later. The
trigger was a transient failure in the attestation endpoint, which is the
consequence the install step's own comment already predicted for a sigstore or
TUF outage. What had not been considered was what that predicted event would
*look like* when it arrived.

So the rules this section exists to state:

**A fail-closed check must not sit in front of the line that makes the tool
reachable.** The `PATH` write is bookkeeping, not a privilege grant: the gates
step is skipped when install fails regardless. Ordering it first costs nothing
and means no future fail-closed check added to that step inherits a
missing-binary disguise.

**A check that can fail must say why.** The audit is captured rather than
allowed to die bare, and its reason is recorded and reported. Fail-closed is
unchanged; the exit is still non-zero and the gates still do not run.

**Conductor invokes itself by absolute path.** `PATH` remains only so the
umbrella can resolve the three *gates* by name, which is the one thing that
genuinely needs it. dep-guard, vault-guard and intent-guard already call their
own binaries by absolute path and document it as resistance to a workflow that
prepends its own `node_modules/.bin`. Conductor resolving *itself* by name was
an inconsistency with a rationale already written down elsewhere in the family.

**A gate that could not run says so on the pull request.** The comment step
does not attempt a render invocation when the install failed, because at that
point the tool is precisely the thing that could not be verified. It posts a
compact could-not-run note carrying the reason, and says plainly that a
registry or sigstore outage is a common cause. Without that sentence a reader
sees "signature verification failed" on their own pull request and reasonably
fears the worst.

**An empty report is never posted as if it were a result.** `pr-comment.mjs`
posts an honest could-not-produce-a-report note instead. This is redundant with
the step above and kept anyway: the incident was three individually correct
mechanisms composing badly, and "unreachable by design" is a claim that decays.

Not addressed here, deliberately: the run-level conclusion stays green while
the check-run goes red, so an adopter watching `gh run list` sees an unbroken
history. That is a property of the `continue-on-error` in the advisory recipe
rather than of this action, and changing what the README recommends means
telling every existing adopter their recipe moved. It needs its own decision.
