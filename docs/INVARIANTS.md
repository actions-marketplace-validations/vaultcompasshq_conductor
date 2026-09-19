# conductor invariants

This is the list of cross-cutting rules the umbrella depends on. It exists
because a cohesion audit should read a checked-in file rather than
re-derive a list from whatever the auditor happened to remember, and
because most of the rules below are true in one file and depended on in
another, with nothing between them that would notice if one side moved.

conductor is a convenience layer on purpose. It runs three gates that are
installed, versioned and released separately, and if this package
disappeared all three would still work. That shape is the source of nearly
every rule here: the umbrella has no library dependency on any gate, so
everything it knows about a gate is reconstructed from that gate's
command-line output, and every reconstruction is a place where the report
can start saying something the gate never said.

Read this before changing anything that decides an exit code, anything
that writes into somebody's repository, and anything that decides whether
a statement goes in a SARIF log as a result or as a notification.

## How to use this file, and how not to

This file records what the code is TRYING to do. That is not the same as
what it does, and it is not coverage. Each claim names the file and the
line that implements it and the test that pins it, so the checking is
repeatable rather than something you have to take on trust.

Where a rule is NOT pinned by any test, this file says so in those words.
Those admissions are the most valuable lines in it. A document that
claimed uniform coverage would be worse than no document at all, because
the next audit would read it, believe it, and confirm the gaps instead of
finding them. A sibling repository's invariants file was written by the
agent doing the fixing and a later audit found three of its claims simply
false, each one sitting exactly where the prose waved a hand at coverage
the code did not have.

That failure mode is not hypothetical here either. This file was written
in one pass, audited by somebody else, and then overtaken by fixes to the
code it describes. The audit found roughly a third of one section's
citations pointing at tests ADJACENT to the claim rather than at the
claim, and two justifications resting on facts about the other gates that
had stopped being true. Every citation has since been re-checked by
reading the TEST BODY rather than the test title, which is the shortcut
that produced almost all of those errors: a title that sounds like the
claim is not evidence, and a citation that sends an audit past a gap
rather than into it is worse than no citation at all.

So: assume this file has the same failure mode until you have checked the
line numbers yourself. Line numbers move. When one does not resolve to
what the sentence beside it says, the code is the fact.

Where prose and code disagree, the code is the fact. That includes the
prose in this file, the README, and the comments in the source. Five such
disagreements were recorded here when this file was written; all five have
since been fixed in the code or the README rather than in this file, and
each is now recorded as history in the section it belongs to.

## What is NOT pinned by any test

The whole list, in one place, so the next audit starts here rather than
reading for it. Each is stated again in its own section with the reason
it is there and what would break in practice.

Six were admitted when this file was written. ALL SIX ARE NOW PINNED.
Two went first: the `RESERVED_OPTIONS` list is derived from `gateArgs` in
one direction and held to three justified exceptions in the other
(tests/policy.test.ts:347 and 356), and
`conductor/blocking-threshold-unknown` is exercised at the normalizer
(tests/normalize.test.ts:62). The remaining four were closed in 0.2.1,
one of them by fixing a real bug rather than only testing around it:

1. A MALFORMED MANIFEST ON REVERT. `revertInit` parsed it with a bare
   `JSON.parse`, so a corrupt one threw where `readManifest` treats the
   same file as missing. Revert now answers `manifest-unreadable`, which
   is deliberately a different conflict from `no-manifest`, and removes
   nothing. Pinned by tests/init.test.ts:926.
2. THE SUCCESS HALF OF THE TEMPORARY-DIRECTORY CLEANUP. Pinned by
   tests/intent-run.test.ts:171, which drives a full passing `runAll`
   through the import and freeze chain and finds no `conductor-intent-`
   entry in the temporary root it injected. The failure
   half was already pinned; this half is the caller's `finally`, and it
   was correct, so no code changed.
3. `--spec` OUTRANKING A FROZEN NATIVE CONTRACT. Pinned by
   tests/intent-prepare.test.ts:230 and 241, which put both in one
   repository and assert the flag's spec is what gets imported and frozen
   and that the gate is not pointed at the repository itself.
4. THE SUBDIRECTORY ANCHORING OF THE CLI. Pinned by tests/cli.test.ts:399,
   which runs the built CLI from two levels down and asserts it produces
   the same report, byte for byte, as the same run from the top.

0.2.2 removed the last defect this section used to record as OPEN rather
than fixed: the CLI's `repoRoot` no longer answers the working directory
when git cannot be asked, so a missing git and a directory outside any
repository are now two named sentences rather than one wrong diagnosis.
All three of its branches are pinned; the section on anchoring says where.
This paragraph briefly admitted the third one, git present but unable to
run at all, as untestable "because a spawn failure that is neither ENOENT
nor an exit code needs a machine in a state a test cannot ask for". That
was wrong, and it is the shape of admission this file exists to catch: a
test writes a `git` with no execute bit into the controlled PATH and the
spawn fails with EACCES. Pinned by tests/cli.test.ts:801.

Three more things belong on this list without being invariants of the
same kind. The first two are unchanged since this file was first written;
the third is new in 0.2.1. `ExitInput.enforce` is REQUIRED
rather than defaulted, which is a compile-time property that no test pins
and no test could. The generated hook's own `exit 1` is asserted on one
of its two fail-closed branches only, which is a partial gap rather than
an absent one; the section on it says which half is which. And
revertInit's `umbrellaHookGone` derivation, which replaces a flag this
release removed, is exercised only through its dry-run branch (by the
dry-run adopt revert); its real-mode branch is not distinguished on its
own, because every other state a test can construct short-circuits at the
changed-hook early return first; the section on what revert guarantees
says why.

Two more arrived in 0.2.3, both about the intent gate's state directory,
and both belong here rather than only in their own sections because this
list is supposed to be the whole of it:

1. THE CANONICAL-FIRST ORDER OF `NATIVE_CONTRACT_PATHS` IS A DECLARATION
   WITH NO OBSERVABLE EFFECT. One test pins the declaration and nothing
   can pin more, because no consumer distinguishes the two entries today:
   the conflict rule refuses every repository that could hold both, so
   `frozenNativeContracts` never returns more than one and only `[0]` is
   read, and `frozenContractIn` is compared to `null` with its value
   discarded. Reversing the pair turns one assertion red and changes no
   behaviour. This is a convention until something reads WHICH of the two
   answered.
2. THE IMPORT-AND-FREEZE CHAIN IS NEVER DRIVEN AGAINST A REAL
   INTENT-GUARD. Every test of it uses `stubIntentGuard`, and the dogfood
   suite exercises only the native flow: it passes neither `--base` nor
   `--spec`, so nothing in the repository runs a real gate through
   import-spec and freeze. This release rests on a behaviour of the real
   1.3.0 build -- that a freeze into a temporary project holding only
   `.conductor/` renames it to `.intent-guard/` and writes there -- and
   that behaviour is verified by READING the gate's `ensureStateDir`, not
   by running it. The post-freeze lookup is written to survive being wrong
   about it, since it accepts either name and fails closed naming both, but
   the claim itself is unchecked. A dogfood case passing `--spec` would
   close this and is the single most valuable test this file is missing.

One more arrives in 0.3.0 with the pull-request trust boundary, and it is a
gap in the FEATURE rather than in its tests: everything the umbrella does
here is pinned, and what is missing is a hole nothing in this release closes.

All three gates are inside the boundary as of 0.3.0: dep-guard 0.6.0,
intent-guard 1.4.0, vault-guard 1.7.0. The composed test the design document
calls the acceptance criterion for the wave now runs, in the dogfood suite,
against all three at once.

1. KNOWN-OPEN: THE INTENT GATE'S IMPORTED-CONTRACT PATH IS OUTSIDE THE
   BOUNDARY, and this one is a HOLE rather than work in flight, so it is
   listed here as open rather than as pending. When a repository has no frozen contract
   and a spec is imported instead, that spec is a file in the head tree: the
   contract being judged against is derived from something the pull request
   controls, and a pull request that adds or edits its own spec is choosing
   part of what it is judged by. Neither the base-ref rule nor the program
   rule closes it. The flag is deliberately withheld there rather than
   pointed at a temporary directory with no repository in it, and the
   withholding is reported like any other, so the state is visible; it is
   not fixed. Freezing a native contract and keeping it committed is a
   workaround, not the fix. The fix is to read the spec from the base ref
   too, and it is not in this release.

## The exit code is composed, not maximised

Three codes and nothing else. 0 means every enabled gate ran and none
blocked. 1 means every enabled gate ran and at least one blocked. 2 means
an enabled gate could not run, so nothing in the report is a clean result.
2 outranks 1 and 1 outranks 0, and the composition is written as two
ordered predicates rather than as an arithmetic maximum
(`composeExitCode`, src/exit-codes.ts:72-81).

The maximum is the obvious implementation and it is wrong, which is why
the function is shaped to make it hard to write. The three products do not
mean the same thing by the same number: dep-guard has a third code, 2, for
"could not run the checks at all", while the other two have only 0 and 1
and use 1 both for a real finding and for a config file they rejected.
Taking a maximum would flatten dep-guard's distinction and would report a
broken config as a policy violation.

Because 2 covers cases the products themselves report as 1, the umbrella
cannot read the child's exit code alone. "Exited 1 and printed nothing
parseable on stdout" is the reliable signature of a rejected config, and
it is treated as could-not-run (src/gate-runner.ts:845-864). So the
composed code can differ from the maximum of the children's, deliberately.

The per-finding `blocking` flag can only ADD to the answer, never subtract
from it: the second predicate is `(gate.exitCode ?? 0) !== 0 ||
gate.hasBlockingFinding` (src/exit-codes.ts:77). A gate that exited
non-zero produces a non-zero composed code whatever the umbrella made of
its output. The flag exists only so a gate whose exit code somehow said
clean while its own report carried a blocking finding still fails the run.

Pinned by tests/exit-codes.test.ts, twelve cases, of which the ones that
matter are "does not take the numeric maximum of the children codes"
(line 43, whose single gate exited 1 and is could-not-run, so the answer
is 2 where the maximum would be 1), "lets could-not-run outrank a
blocking gate rather than the other way round" (line 34), and "is 1 when
a gate reported a blocking finding even if its exit code did not" (line
22). The wiring from a real
run into that function is tests/run.test.ts:73, which drives a gate whose
output has drifted shape and asserts the composed code is 2 and not 1.

`ExitInput.enforce` is REQUIRED rather than defaulted
(src/exit-codes.ts:69), so a call site that has not thought about
enforcement does not compile. That is a compile-time property and no test
pins it; a test could not.

## An unenforced gate is filtered out, and nothing else about it changes

`enforce: false` in the policy file removes a gate from the exit-code
composition entirely (src/exit-codes.ts:73). It is not a downgrade. The
gate still runs, its findings keep their own severities, their `blocking`
flags are untouched, and both output formats report it exactly as they
report an enforced gate, with one added sentence saying its verdict did
not reach the exit code.

This is the adoption ramp. `conductor init` writes `enforce: false` for
the intent gate and `enforce: true` for the other two
(src/init.ts:977-983), so a fresh repository gets the ramp rather than
three repositories being hand-edited into it.

The rule that makes it safe is that nothing reads a gate's output and
decides to ignore it. The umbrella reads a line somebody wrote in their
own policy file, and the line changes exactly one number.

Two consequences are worth stating because they look like bugs:

A run can exit 0 with BLOCKING on the screen above it. The text verdict
therefore carries the reason on the same line rather than leaving it to
the sections: the clauses are built in `unenforcedClauses`
(src/output-text.ts:378-399) and appended to the exit 0 verdict at
src/output-text.ts:517-525, with the same clauses carried as an aside on
the exit 1 and exit 2 verdicts (src/output-text.ts:478-482).

An unenforced gate that could not run still produces a critical,
error-level RESULT in the SARIF log, not a note. `conductor/gate-missing`
and `conductor/gate-failed` keep their severity and their result standing
whatever the policy says about enforcement (src/normalize.ts:722 for the
severity, src/output-sarif.ts:136-142 for the level, and 953-958 for the
findings going into the umbrella's run rather than being reclassified),
and only the umbrella's own `gate-not-enforced` notification says the
verdict did not reach the exit code.

This was recorded here as a disagreement with the README, which used to
summarise enforcement as making such a gate "a note rather than exit 2".
That was true of the exit code and false of the published log. The README
was the wrong one and now says the same thing this section does
(README.md:186-192), and the rule is pinned by
tests/output-sarif.test.ts:1027, which renders an unenforced gate that
could not run and asserts the result's level is `error` and its severity
`critical`, with the `gate-not-enforced` notification beside it.

The report header and the verdict deliberately count different things.
The header counts findings across every gate, because it is an inventory
of what follows it and a reader counting lines on screen has to arrive at
that number (src/output-text.ts:735-747). The verdict counts only
enforced gates, because it answers what failed the run
(src/output-text.ts:423-445). Two questions, two numbers.

Pinned by tests/exit-codes.test.ts:52, 58, 66 and 75;
tests/output-text.test.ts:448, 456, 463 and 468 (an unenforced gate that
blocked: the findings and their BLOCKING marker survive, the header is
marked, and the verdict does not claim none blocked), 495, 500 and 507
(an unenforced gate that could not run is loud, is not exit 2, and is not
also called a gate that blocked), 538, 551 and 559 (only enforced gates
are named as the reason and counted), and especially 579 ("lets the
header count everything on screen while the verdict counts what failed",
which asserts the header says 3 findings while the verdict says 2 across
1 gate); tests/cli.test.ts:482, 498, 528 and 543, end to end through the
CLI; and tests/output-sarif.test.ts:1015, 1027, 1060, 1080 and 1094.

## A gate that could not run is a result, never a note

Eight reasons, enumerated as a union so a new one cannot be spelled freely
(`CouldNotRunReason`, src/gate-runner.ts:44-71): a missing binary, a
configured command that is not there, a spawn failure, the gate's own
error exit, output the umbrella could not read, a preparation that never
got as far as spawning anything, and the two pull-request-mode refusals
added in 0.3.0, `trust-base-unverified` for a gate in the version table
whose version could not be read and `gate-program-refused` for a gate whose
program is a file the head controls. The last two are separate rather than
one shape of the other because they send a reader to different places: one
is a packaging problem with the installed gate, the other is a pull request
choosing the program that judges it.

Each one produces a finding of the umbrella's own, critical and blocking,
with no SUBJECT (`gateProblem`, src/normalize.ts:710-738, and the four
functions that call it at src/normalize.ts:748-900). Its SARIF result is
still filed against the policy file, by the rule on locations below, since
a result with no location at all makes code scanning reject the whole log.
The subject and the location are two different things here and the
distinction is the point: nothing about the scanned tree is claimed, and
the file the result is filed against is where the gate is enabled. That is
not symmetry
for its own sake. A gate that never ran gets no SARIF run of its own, by
the rule below, so without one of these findings the published report
would carry no trace of the most important thing that happened.

A gate that exits above 1, or does not exit normally at all because it was
killed or timed out, is could-not-run (src/gate-runner.ts:826-843). A gate
that exits 1 with stdout that will not parse as JSON is could-not-run
(src/gate-runner.ts:845-864). Reporting the second as a policy violation
would tell a user their code is at fault when their config is.

Pinned by tests/gate-runner.test.ts:167, 177 and 201, and end to end by
tests/run.test.ts:73 and tests/cli.test.ts:116.

AGENTS.md and README.md both used to say the umbrella raises no findings
of its own "beyond conductor/gate-missing". That was false and always had
been: the union at src/normalize.ts:705-708 has three members, and the
README named `conductor/gate-failed` elsewhere in the same document.
Three, plus the two normalization diagnostics, is the number, and both
documents now list all five (AGENTS.md:12-16, README.md:684-688).

The README half of that pair was pointing at the wrong place and had been
since it was written. It named the paragraph about mirroring the Action's
inputs into the pull request comment step, which has nothing to do with the
umbrella's own findings; the list of five is in the "what is in and what is
out" section. Found in 0.3.0 by doing what the top of this file asks and
reading the body at the cited line rather than trusting the number.

## runGate is total

`runGate` never throws. That is a contract and not a hope, and the reason
is structural: the caller maps over the enabled gates in order
(src/run.ts:399-484), so an escaping error does not merely lose one gate's
report, it loses every gate after it, and it surfaces as a stack trace
with exit 1, which the pre-commit hook then reports as "a gate blocked".

The backstop is src/gate-runner.ts:620-639. The `catch` around
normalization is deliberately NOT narrowed to `NormalizeError`
(src/gate-runner.ts:884-904): that narrowing was the original defect, when
a normalizer reading a property off a null array element threw a
`TypeError`, which escaped everything. The normalizers now validate every
field they read before reading it (src/normalize.ts:49-90), and the broad
catch is the second line of that defence rather than the only one.

Pinned by tests/run.test.ts:69 ("does not throw"), 89 ("still runs and
reports the other two gates") and 102 ("carries no stack frame anywhere in
the outcome").

## Where the tool refuses rather than guesses

The umbrella has no built-in default policy. A missing `.guardrails.yaml`
is a `PolicyError` naming the file and telling the user to run
`conductor init` (src/policy.ts:373-379). A run that gates a commit has to
be explainable from a file in the repository rather than from something
compiled into a binary. Pinned by tests/cli.test.ts:151.

An unusable changed-path set fails closed. `changedPathsSince` returns a
failure rather than an empty list on any git error, because an empty path
set is indistinguishable from a clean run (src/intent-base.ts:109-125). It
also refuses a path containing a comma, since `--paths` is comma-joined
and such a path would arrive at the gate as two paths, inventing one
breach and hiding another, and it refuses a path with leading or trailing
whitespace for the same reason (src/intent-base.ts:133-158). A space in
the middle of a filename is ordinary and passes through untouched. Pinned
by tests/intent-base.test.ts:144, 162, 174, 181 and 202, and end to end by
tests/intent-run.test.ts:357 and 379.

A missing umbrella binary blocks the commit. The generated hook exits 1
rather than warning and letting the commit through (src/init.ts:504-511).
A guardrail that switches itself off when the tool is missing is a
guardrail an attacker turns off by making the tool missing. The hook says
two different things depending on whether git was available to locate
`node_modules/.bin`, because "git is not on this hook's PATH" and
"conductor is not installed" send a reader to two different fixes.

The coverage here is uneven and worth stating precisely, because the two
halves are pinned differently. That the commit is REFUSED is pinned by
tests/init.test.ts:1468 and 1566, which drive a real `git commit` with no
conductor anywhere and assert git's own status is non-zero and the
message says NOT checked. That the HOOK ITSELF exits 1 is asserted in one
place only, tests/init.test.ts:1485, and only on the git-missing branch:
it runs the hook directly and asserts `run.status` is 1. Nothing asserts
the hook's own exit code on the ordinary "conductor: command not found"
branch, where a hook that exited 127 or 2 would still make the commit
fail and still pass those tests. The message on that branch IS pinned
(tests/init.test.ts:1482). A neighbouring test also asserts `run.status`
is 1 (tests/init.test.ts:1546), but that 1 is passed through from the
stub conductor it installs and is not this branch of the hook at all.

An unknown `--stage` is a usage error and never a silent full run
(src/cli.ts:213-221). Both directions of the quiet failure look like
success: a typo that runs every gate reads as a passing build with more
coverage than it has, and a typo that runs none reads as a passing build
with no coverage at all. Pinned by tests/cli.test.ts:225.

One place reads the same file two ways, on purpose, and the reason is
worth stating because it used to be an asymmetry rather than a decision.
`readManifest` treats an unparseable manifest as a missing one, because
"the record is unreadable" is not evidence that a file on disk is the
umbrella's (src/init.ts:858-868). `revertInit` does NOT reuse it, because
revert has to tell the two apart: a missing manifest means there is no
record to act on, an unreadable one means there is a record and it cannot
be trusted, and those send a reader to different fixes. It answers
`no-manifest` for the first and `manifest-unreadable` for the second, and
removes nothing either way (src/init.ts:1461-1494).

What `manifest-unreadable` actually covers is narrower than the names
above suggest. It is raised when the file does not PARSE at all:
truncation, conflict markers left behind by a bad merge, anything
`JSON.parse` itself rejects (src/init.ts:1479-1494). It is not raised for
valid JSON of the wrong shape: an empty object, a `files` key that is
`null`, a manifest missing `files` entirely all parse cleanly and then
reach `manifest.files.map` a few lines later, where they throw a raw
TypeError instead of returning either named conflict. That reaches the
user as a one-line exit 2 with a runtime message, which is the pre-fix
behaviour the rest of this section describes as fixed; it is not, for
this shape of file. `recordedHookSha` (src/init.ts:872) makes the same
shape assumption on the init side, and that one predates this release.

`revertInit` used to parse that file with a bare `JSON.parse` and no
guard, so a corrupt manifest made `--revert` throw. The throw was caught
in `main` and printed as one line with exit 2 (src/cli.ts:434-448), so
nothing leaked a stack, but the message was a JSON parser's: a user whose
manifest was truncated by a crash or a bad merge got `Unexpected end of
JSON input` and no indication which file was unreadable or that the fix
is to repair or delete it by hand. Nothing pinned it, because every test
that touched the manifest wrote valid JSON back. Now pinned by
tests/init.test.ts:926.

## The gates are installed without scripts, and verified before they are trusted

The four packages this action installs are CONTROL INPUTS: they decide whether a
pull request may merge. Two properties follow, and both are properties of the
install step rather than of any gate.

`--ignore-scripts`, because the step runs on a runner holding the job's token.
Without it every package in the resolved tree gets arbitrary code execution
there on every run, which is a strange amount of trust to extend from the tools
whose job is deciding whether this repository can be trusted. Checked against
the real registry rather than assumed to carry over from one gate: all four
install and report their own versions correctly with the flag set.

A ROOT MANIFEST, and it is load-bearing rather than tidiness. `npm audit
signatures` audits the tree's EDGES OUT, and a global install leaves
`<prefix>/lib` with a `node_modules` and no manifest, so the root declares
nothing and the four packages just installed sit on the far end of no edge.
Without it the audit covers their dependencies and SKIPS ALL FOUR GATES.
Measured on this exact tree: 32 signatures and 8 attestations without the file,
36 and 12 with it, and the four missing ones are the gates. The single-package
version of this step shipped in vault-guard without the manifest and recorded
the short count as evidence that it worked.

WHAT THE VERIFICATION PROVES, narrowly, because the obvious summary is wrong. It
asks the registry for each name and version in the tree and checks the signature
served back. It does NOT read the installed files, so a tampered install is
invisible to it. It does NOT defeat a compromised registry, which signs what it
serves. And a MISSING attestation is not a failure, only a missing or invalid
signature is, so it does not require provenance despite all four packages
publishing it. What remains is that every name and version in the tree, gates
included, has to be one npmjs currently serves with a valid signature.

THE CLIENT HAS A FLOOR, AND IT IS npm 10.5.2. `npm audit signatures` is not
version-stable: below 10.5.2 it fails on a CLEAN install of these very
packages, because the client's bundled keys and TUF root are stale. On 10.5.0
it says "Someone might have tampered with these packages", naming ours; on
10.2.4 it is `EEXPIREDSIGNATUREKEY`. Bisected against a real four-gate install,
with a cold cache and a fresh home so no newer client could have primed the TUF
root or the key set: 8.19.4, 9.9.4, 10.2.4, 10.5.0 and 10.5.1 fail; 10.5.2 and
later pass, and 10.5.2 verifies the same package and attestation counts as
current npm rather than a reduced set. That band maps to Node 18.19.x and 20.10
through 20.12. An earlier draft of this paragraph put the floor at 10.6.0, from
a bisection that tested 10.5.0 and then 10.6.0 and never tested what lay
between: Node 20.13.0 and 20.13.1 ship npm 10.5.2, so that floor refused
working clients while telling them they could not verify.

**A BARE MAJOR DOES NOT CLEAR THE FLOOR.** Node 22.0.0 ships npm 10.5.1, inside
the failing band, and `setup-node` satisfies a major-only spec from the runner's
tool cache when it can. The sibling actions pin `node-version: '22'` and still
carry this floor for that reason: an earlier version of that wave left it out on
the grounds that the pin covered it, and it does not.

The floor extracts the first version-shaped token rather than validating the
string and then splitting it. A `grep -Eq` shape check matches PER LINE while
the arithmetic reads the WHOLE string, so a client printing an upgrade notice
above its version passed the check and then failed the comparison, leaving the
floor skipped. That shipped twice here. An output with no version in it is
refused, because a guard that fails open when it cannot see is not a guard.

KNOWN CONSEQUENCE OF FAILING CLOSED: a runner pointed at a mirror or proxy that
does not serve `/-/npm/v1/keys`, or a sigstore outage, installs fine and then
fails this step with `EMISSINGSIGNATUREKEY`. Documented in the README rather
than left to be discovered from a red required check.

**Enforced by:** `tests/action.test.ts`, which runs the real install script
against a stubbed npm and asserts the full argv in order (so a second npm
invocation cannot be added or removed unnoticed), that the manifest names all
four packages, and that a version override reaches the manifest as well as the
install.

A precision that matters, because the obvious reading is wrong: the audit
resolves each edge BY NAME and audits the version on disk. A manifest declaring
a wrong or nonexistent version still audits the installed one and exits 0, and a
manifest naming a package that is not installed is skipped silently, also
exiting 0. So the NAMES are what make the check cover the gates; the version
assertions keep the file from drifting away from the install, and are not
themselves a security property. The stub is npm, so these prove the action ASKS; the counts
above are what a real npm does.

## On a pull request, no version input may pin BACKWARD

New in the v0.4.3 action tag. The shape check above asks whether each of the
four inputs is an exact version. It says nothing about WHICH one, and it is not
the control for version choice. On a same-repo `pull_request` event GitHub runs
the workflow file from the HEAD, so all four inputs are written by the pull
request being judged. Once a gate has two published versions that is a bypass
with an innocent shape: deleting a control reads as deleting a control, while
`intent-guard-version: 1.4.0` reads as version management. It is not
hypothetical here, because this tag ships intent-guard 1.5.2 and 1.4.0 is
published.

So where `GITHUB_BASE_REF` is non-empty the validate step refuses any of the
four inputs naming a version BELOW the one this action tag ships, and accepts
anything at or above it. Pinning FORWARD stays allowed, which is the direction
the inputs exist for. That rests on an ASSUMPTION the rule does not enforce:
that a newer gate is at least as strict. Nothing bounds a forward pin, so a
version ahead of the tag's is accepted whatever its rules turn out to be.

Five properties, each load-bearing:

- `TAG_<GATE>_MAJOR/MINOR/PATCH` in `action.yml` are SEPARATE constants from any
  flag floor, and must not be merged with one even where they hold the same
  number. `TRUST_BASE_MIN_VERSION` in `src/gate-runner.ts` is FLAG
  COMPATIBILITY: the oldest build of each gate that understands `--trust-base`.
  These are the tested versions this TAG ships. One constant serving both is how
  raising one silently raises the other. The two already disagree for
  intent-guard: the floor is 1.4.0 and the tag ships 1.5.2.
- The comparison is against those hardcoded constants, never against anything
  derived from an input. An input looks identical whether a consumer pinned the
  current version or the default supplied it, so the step cannot tell a pin from
  a default; the constant is the only source of truth. It is trustworthy because
  `action.yml` comes from the ref the consumer's workflow names, not from the
  pull request's tree. That holds for `vaultcompasshq/conductor` at a ref and
  NOT for a local-path reference, which reads `action.yml` out of the pull
  request's own tree; this repository's own workflows reference it that way.
- One comparison function, called four times. Four hand-written copies would be
  four places for one to drift into a weaker shape, on a check where the weaker
  shape is the failure.
- The event test is `GITHUB_BASE_REF` being non-empty, the same one the run step
  uses to decide whether to pass `--trust-base`, rather than a second detector
  to keep in step. It rests on a PLATFORM GUARANTEE worth recording, because a
  same-repo pull request's author writes the workflow file and the obvious
  bypass is therefore `env: GITHUB_BASE_REF: ""` at job level: GitHub documents
  that the default `GITHUB_*` and `RUNNER_*` variables cannot be overwritten and
  that such an assignment is ignored
  (https://docs.github.com/en/actions/reference/workflows-and-actions/variables).
  That is also why the step reads the runner's own default variable rather than
  declaring `GITHUB_BASE_REF` in its `env:` mapping.
- Written accept-only-if, not refuse-if, for the same reason as the npm floor:
  `[` exits 2 on a malformed or out-of-range comparison and an `if` reads 2 as
  false, so a refuse-if shape turns an arithmetic error into permission.

**What this does NOT cover, stated because the obvious summary is wider than the
rule.** It closes pinning backward on a SAME-REPO pull request, and nothing
else.

- Not forks, and on forks the rule costs something rather than merely doing
  nothing. A fork's `pull_request` run uses the BASE repository's workflow file,
  so a fork author never writes the pins that judge them and there is no hole
  there to close. But `GITHUB_BASE_REF` IS set on a fork pull request, so the
  check fires anyway and judges the base repository's own trusted workflow file.
  A maintainer's deliberate backward pin there fails EVERY fork pull-request
  run: a false refusal, on a pin nobody untrusted wrote. The remedy is the same
  as for any consumer, which is to remove the input.
- Not a pull request that deletes the step, moves the `uses:` pin to an older
  action tag, or edits the job away. Those are workflow-file edits, and the
  control is branch protection on the base branch with review required for
  `.github/workflows`. Nothing in `action.yml` can substitute for it, and this
  entry claims no more than the rest of this file does about that boundary.
- Not push events. The rule fires exactly where `GITHUB_BASE_REF` is set, which
  is `pull_request` and `pull_request_target`; push runs are out of scope and
  the shape check remains their only version gate. Read that as SCOPE, not as
  safety: a push to an UNPROTECTED branch runs that branch's own workflow file,
  written by the same author, with `GITHUB_BASE_REF` empty, so it is as
  author-controlled as a pull request and the rule does not cover it.
- Not the version the gates are compared against being right. The constants say
  what this tag ships, not what is good.

**Enforced by:** the `refuses a pull request that pins a gate backward` cases in
`tests/action.test.ts`. Three of the four constants equal their input's default
with nothing published between them, so those cases drive the real step text
with one constant advanced a minor version, which is the action as it will be
the day a newer gate ships, and assert the replacement matched, so deleting or
renaming a constant turns them red. intent-guard needs no such copy: 1.4.0 is
published and below what this tag ships, so the shipped step refuses it. Plus a
drift case tying each constant to its input's default, a `1.10.0` case on the
accepted side that a lexicographic comparison would refuse, and a text case
pinning the accept-only-if shape and the event gate in order.

## The pull-request trust boundary: the rules come from the base ref

New in 0.3.0. Every gate reads its own rules out of the repository it is
judging, and on a pull request the author controls that repository. The
umbrella's version is the sharpest in the family because its policy file
can name a program to run: one commit could point a gate's `command:` at a
script the same commit added, or set `enabled: false` on the gate that
would have caught what else was in it, and the report said the run was
clean. The gate ran. It ran the pull request's own program under the pull
request's own rules.

With `--trust-base <ref>` the policy is read from that ref with `git show`
and the head tree is judged against it (`policyForRun`, src/cli.ts:131-196,
reading through src/trust-base.ts:137-147). THE HEAD'S POLICY FILE IS NEVER
PARSED INTO A RUN in that mode, which is the whole of the fix. It is read
for exactly two things, and neither can change what happens: a comparison
so the difference can be reported, and, when the ref itself cannot be used,
an inventory of gate names so the report can say which gates did not run.

READS ONLY, AND NEVER INTO THE REPOSITORY: `git rev-parse` and `git show`,
no checkout switch, no worktree, no stash, no write of any kind
(src/trust-base.ts:20-42 for the rule, 58-68 and 137-147 for the two calls).
An umbrella that moved somebody's HEAD to do its job would be a worse bug
than the one it fixes.

A CHANGE TO THE RULES IS PROPOSED, NOT REFUSED. Rules legitimately change,
and a gate that blocked every such pull request would train people to
bypass it, so a differing policy is one line and the run continues under
the base ref's rules (`POLICY_PROPOSAL_LINE`, src/trust-base.ts:182). The
comparison is of PARSED DOCUMENTS, so a reflow or a re-quote is not a
proposal (`policyDiffers`, src/trust-base.ts:167-179); when either side
will not parse the raw text is compared instead, which is the fail-closed
direction. Both sides are read through `git show`, base and head alike,
because intent-guard learned the other way: it read its head side from the
working tree with a call that follows symlinks, so a pull request that
replaced a control file with a link compared equal and was reported as
changing nothing.

Proposals are summed and never counted as findings (`ControlProposal` and
`collectProposals`, src/run.ts:93-99 and 356-370). Nothing there reaches a
severity, a fingerprint, a summary or the exit code, and that is
deliberate: a pull request is ALLOWED to propose changing the rules.

IT FAILS CLOSED THREE WAYS, all mirroring intent-guard's own refusals so
the two gates give one answer to one mistake (`refuseTrustBaseRef`,
src/trust-base.ts:84-126): a ref that will not resolve, a ref that resolves
to the head commit, and a different commit carrying the head's tree. The
last two are not hypothetical typos. On a `pull_request` event
`github.sha` IS the merge commit, which is HEAD, and what GitHub publishes
as the merge ref carries the head branch's tree whenever the base has not
moved since the fork.

Each of the three makes every enabled gate could-not-run and exits 2
(`refusedTrustBase`, src/run.ts:306-346). TWO THINGS THERE ARE DELIBERATELY
NOT READ OFF THE POLICY, because the policy in hand is the head's:
`enforce` is forced true on every synthesized outcome, since enforcement is
itself a control input living in the file that could not be read; and the
exit code is WRITTEN rather than composed, since a head policy enabling no
gate at all would compose to 0 over an empty list and report a run that
checked nothing as a clean one.

AND THE REFUSAL IS CARRIED ON THE RESULT, so both renderers lead with it
before any question about how many gates there are (`RunTrustBase.refusal`,
src/run.ts:110-127). That is not tidiness. The gate list on a refused run is
the HEAD's, because the base policy is the thing that could not be read, and
a head that switches every gate off, or that will not parse, leaves it
empty. Both reports asked the gate-count question first and fell straight
through: the text verdict printed "exit 0, no gate ran because none is
enabled. Set enabled: true", and SARIF emitted `{"runs": []}` with
`executionSuccessful` absent, while the process exited 2 and nothing had
been checked. An empty log uploads cleanly and is indistinguishable from a
scan of a repository nobody gated. Reachable on the DEFAULT
actions/checkout, which fetches depth 1 and so carries no base ref.

So a refusal is its own outcome in both formats: the first line, the reason,
the fetch-depth remedy and its own verdict sentence in text
(`refusalLines`, src/output-text.ts:412-422, and the branch at the top of
`verdict`, src/output-text.ts:423-435); and in SARIF it earns the umbrella
run unconditionally and raises `conductor/trust-base-refused` at ERROR level
(`trustBaseRefusedNotifications`, src/output-sarif.ts:716-730, with the
unconditional clause at src/output-sarif.ts:985-989).

THAT NOTIFICATION IS THE ONLY ONE IN THIS PACKAGE THAT IS NOT A NOTE, and
the exception is narrow on purpose. Every other notification says how much
of the policy a run covered; this one says the run did not happen. It is
still a notification rather than a result because there is no code and no
configuration it is about, and the could-not-run results for whatever gates
the inventory did name sit beside it carrying the same sentence, so a
consumer reading only results still learns that nothing ran.
`executionSuccessful` is false on a refusal whatever the gate list says:
`every` over an empty list is vacuously true, which would have claimed the
analysis completed on the one run where nothing was attempted.

THE PROGRAM IS CHECKED AS WELL AS THE RULES, and without this the rest of
this section is worth nothing. Two shapes, both of which look ordinary in a
diff and both of which were live before 0.3.0:

  A base `command:` pointing INSIDE the repository, at something like
  `vendor/vault-guard`. The path came from the base and is approved; the
  file at that path is whatever the head put there. The umbrella runs the
  pull request's own program, is told the scan was clean, and reports a
  clean scan.

  No `command:` at all. Resolution prefers the repository's own
  `node_modules/.bin` over PATH, deliberately, so a project pin beats a
  global install (the rule two sections down). A head that commits
  `node_modules/.bin/<gate>` shadows the real gate, and a stub answering
  `--version` with a plausible number passes every other check. Through
  0.3.0 the composite action installed nothing, so the plant survived the
  install step. CLOSED ONE STEP EARLIER SINCE 0.4.0: on a pull-request run
  that location is not searched at all, so this shape no longer reaches the
  program rule below. See "The Action installs outside the tree" further
  down, which is where the description of the current behaviour lives; the
  program rule is still what catches the other two shapes, and it is still
  what would catch this one if the skip were ever removed.

A third shape defeats a per-file check on its own, and it was found by a
reviewer AFTER the first two were closed, which is the reason the unit of
approval is what it is:

  A base-approved WRAPPER. `vendor/vault-guard` is byte for byte what the
  base approved and is the path the policy names; it execs `vendor/impl.sh`,
  which the head rewrote. Nothing in the diff touches the path the policy
  names. Measured before the fix: exit 0, secret missed, zero proposals. The
  same shape reached `trust-base-unverified` with `enforce: false` and exit 0
  when the replaced helper exited 3 on `--version`.

The rule (`refuseHeadControlledProgram`, src/trust-base.ts:343-429, called
from src/gate-runner.ts:720-733 and, for the intent gate's preparation, from
src/run.ts:409-423): a program OUTSIDE the working tree is
accepted, since a pull request cannot write it. A program inside is accepted
only when BOTH hold: it is a tracked regular file whose blob is identical at
the trust base and at HEAD, AND the tree object id of its CONTAINING
DIRECTORY is identical at those two refs. Both sides come from `git ls-tree`
and neither from the working tree, so an uncommitted edit cannot make a file
look approved.

WHAT IS VETTED IS THE PROGRAM FILE AND EVERYTHING IN ITS DIRECTORY SUBTREE,
and nothing else. A tree object id covers the whole subtree in one
comparison, so this needs no knowledge of what a wrapper calls. Anything the
program reaches OUTSIDE that directory is NOT vetted, which is a real limit
rather than a hedge: an in-repo gate has to be self-contained within its own
directory, and that is stated in the README in those words because an
adopter has to be able to satisfy it.

A PROGRAM AT THE REPOSITORY ROOT IS REFUSED, with a message saying to give it
a directory. At the root the containing directory is the whole repository, so
the comparison is the root tree and every pull request that changed anything
differs, which is every pull request. Refusing with the remedy beats a rule
that silently means "no pull request may change anything". (The root trees
also cannot be equal by the time this runs: `refuseTrustBaseRef` has already
refused a base whose tree matches HEAD's.)

A SYMLINK INSIDE THE REPOSITORY IS REFUSED ON ITS OWN ENTRY, before its
target is considered: it is either untracked, or its tree entry is a link
rather than a regular file, and either one refuses. The TARGET is vetted too,
and that is what catches a link whose own path is outside the tree pointing
into it; it never decides the in-repo case. An earlier wording here said the
symlink was "followed and its target vetted", which reads as accepted when
the target is fine, and was doubly wrong: it described a check the code does
not make, and on a machine whose working tree sits under a symlinked mount
the link's own entry was not being vetted at all (see `withResolvedParent`,
src/trust-base.ts:254-257). The repository root arrives realpath'd and the
program path did not, so the link's own spelling compared as OUTSIDE the tree
and was skipped in silence. Pinned now by tests/cli.test.ts:1727 and 1753,
the second of which is the one that would have caught it: the link's target
is unchanged between the refs, so vetting only the target accepts the run.

IT RUNS BEFORE THE VERSION PROBE, and that ordering is the whole of it: the
probe RUNS the program (called at src/gate-runner.ts:735, after the check at
720), so checking provenance afterwards would already have executed the
plant. A stub answering `--version` with a plausible number is the cheapest
form of this attack.

NOTHING UNDER `node_modules` IS EVER BASE-APPROVED, and this is the correct
answer rather than a limitation of the check. What is there is chosen by the
head's own manifest and lockfile and installed by a step that runs before
the gates, so git has no record of those bytes at either ref and `ls-tree`
finds nothing. A pull request that edits its lockfile to pull a different
build of a gate has chosen its own judge as surely as one that commits a
stub. Vendoring still works, as long as the pull request does not change it.

SINCE 0.4.0 THE RULE IS NEVER ASKED THAT QUESTION, because resolution does
not offer it a `node_modules` program on a pull-request run
(`skipNodeModules`, src/resolve.ts:185-206, decided at
src/gate-runner.ts:653-659 from whether a trust base is set). The answer would
be the same refusal every time, and that was the defect: correct, and it
turned every ordinary pull request in a repository whose gates are
devDependencies into three refusals and exit 2. The paragraph above still
states the rule, because the rule is what makes the skip safe rather than a
weakening: the skip removes a location whose every answer was "refused",
and it removes nothing the check would have accepted.

BOTH PULL-REQUEST-MODE REFUSALS ARE ENFORCED WHATEVER THE POLICY SAYS
(src/gate-runner.ts:393 for a refused program, src/gate-runner.ts:763 for an
unverifiable version). `enforce: false` is a standing decision about what a
gate's FINDINGS are worth, and neither of these gates produced any: the
umbrella declined to run at all. Letting an unenforced gate swallow the
program refusal would let a pull request pick its own judge and keep the run
green, and that was reachable: through the wrapper shape, a head-replaced
inner script exiting 3 on `--version` landed on the version refusal with
`enforce: false` and exit 0. The directory rule closes that path, so what is
left on the version side is a packaging problem, and one that fails a build
loudly beats a boundary that quietly downgrades itself on the runs where
something is already wrong.

THERE ARE FOUR PLACES ENFORCEMENT IS OVERRIDDEN IN THIS PACKAGE, and earlier
wordings here said two and then three, each of them false the day it was
written. Three are per-gate. A refused PROGRAM, written once in
`gateProgramRefused` (src/gate-runner.ts:393) and returned by both the places
that can refuse one, `runGate` and the intent gate's preparation. An
unverifiable VERSION (src/gate-runner.ts:763). And an intent PREPARATION that
failed under a trust base (src/run.ts:454), which arrived with the
preparation check above: a pull-request run whose intent gate could not be
prepared is one where nothing judged the intent, and reading the flag there
let a base policy carrying `enforce: false` report the failure and still exit
0. The fourth is the whole-run one: `refusedTrustBase` synthesizes every
enabled gate as could-not-run with `enforce` forced true (src/run.ts:314),
because the policy in hand there is the HEAD's and `enforce` is itself a
control input living in the file that could not be read. All four are the
same reasoning applied at two scopes, which is why the miscount keeps
happening: the gate that could not be judged, and the run that could not be
judged. Nothing else reads a gate's output and decides to ignore the policy.

THE PASS-DOWN IS CAPABILITY-GATED PER GATE (`TRUST_BASE_MIN_VERSION` and
`decideTrustBase`, src/gate-runner.ts:96-104 and 160-223, decided after the
version probe and before the command line is built at
src/gate-runner.ts:741).
The flag goes only to a build that understands it. Both directions matter:
handing an older build a flag it does not parse makes it exit non-zero with
no JSON, which the umbrella correctly reports as could-not-run, so a wrong
guess turns a working repository's pull requests red rather than merely
leaving a gate un-hardened. It is also withheld when the intent gate runs
against a contract imported into a temporary directory, because the flag
names a git ref and the gate resolves it against its own `--project`, where
there is no repository.

The table holds all three: dep-guard at 0.6.0, intent-guard at 1.4.0,
vault-guard at 1.7.0. An entry here is the whole of adopting a gate into the
boundary, which is why it stays a TABLE now that every product is in it: a
fourth role can arrive without an entry, and the "no pull-request mode yet"
branch is what keeps that gate from being handed a flag it would reject.
That branch is unreachable by any gate this package knows today and is kept
for the next one, which is the honest description of it.

FOR A PRODUCT IN THE TABLE, AN UNREADABLE VERSION IS COULD-NOT-RUN, not a
downgrade (src/gate-runner.ts:205-212). A gate in the table is one this
repository expects to be inside the boundary, and a probe that fails leaves
that unestablished for an unexplained reason; running it anyway would put it
quietly outside the boundary on exactly the runs where something is already
wrong. For a product outside the table nothing is unknown and the withheld
line stands. The two are separate for that reason and not for symmetry.

WITHHOLDING IS NEVER SILENT. A gate that was not put into pull-request mode
read its own rules out of the tree being judged, which is the thing this
exists to prevent, so it gets a line in the full report, a clause on the
clean one-line summary, and a `conductor/trust-base-not-passed`
notification (`withheldTrustBase` and `trustBaseLines`,
src/output-text.ts:313-318 and 353-368, and
`trustBaseWithheldNotifications`, src/output-sarif.ts:784-807).

Both new SARIF statements are NOTIFICATIONS by the discriminator further
down this file, and neither is a close call once that rule is applied. A
proposed control change is a statement about configuration: nothing went
wrong, it did not take effect, and it stays true of every push to the
branch until it merges, so as a result it would be a fingerprint-less alert
reappearing on every run. A gate with no pull-request mode is a coverage
statement in the same shape, true because an older gate is installed.

Pinned at four levels. The decisions: tests/trust-base.test.ts (17 cases
over the three refusals, reading the policy at a ref, the document
comparison and the version floor, all against real git repositories rather
than a mock). The capability gate: tests/gate-runner.test.ts:260-412 and
414-588. The run: tests/run.test.ts:496-566 (the refusal, including that a
head policy of all-unenforced or of no enabled gate still exits 2) and
568-790. The CLI, against a real repository whose feature commit rewrites
the policy to point the secrets gate at a script it adds:
tests/cli.test.ts:879-1186, where the marker file appears without
`--trust-base` and does not appear with it. End to end against the real
gates, tests/dogfood.e2e.test.ts:461-647. The proposal notifications are
pinned separately at tests/output-sarif.test.ts:1571-1698, and the
`Self-approval refused:` reason at tests/normalize.test.ts:540-762.

The three additions of the fix round are pinned separately, because each of
them is a way the mechanism above was true and the REPORT of it was not:

- The refusal as its own outcome: tests/output-text.test.ts:1028-1088 (exit
  2 and the reason with no gate in the inventory, the fetch-depth remedy,
  leading with it, still naming the gates there were, and never the clean
  one-line summary) and tests/output-sarif.test.ts:1710-1785 (the run
  exists, the notification and its ref, error level, `executionSuccessful`
  false, the could-not-run results survive, silence when not refused). End
  to end through the CLI on a real repository at tests/cli.test.ts:1049,
  1077 and 1116, the last of which is a head policy that will not parse.
- The program rule: tests/cli.test.ts:1210-1795, eighteen cases on real
  repositories. All THREE attack shapes are driven BEFORE and after, so each
  refusal is measured against a run where the planted program demonstrably
  did execute rather than against an assumption that it would have. The
  wrapper shape is at tests/cli.test.ts:1412-1578, with the two directions
  that keep the directory rule usable rather than a ban on vendoring beside
  it: a vendored directory left entirely alone is accepted, and a change
  elsewhere in the repository refuses nothing. The mutation that matters for
  those two is comparing the ROOT tree instead of the directory tree, which
  reddens four.
- The version refusal and the vault-guard pass-down:
  tests/gate-runner.test.ts:261-413 and 415-589, with the summed proposal at
  tests/run.test.ts:647 and the real gate at
  tests/dogfood.e2e.test.ts:779-859, which drives the sibling's built
  vault-guard through the policy's absolute `command:` and skips, loudly,
  when there is no such build on the machine.

All three gates are in the table as of 0.3.0, and THE COMPOSED TEST THE
DESIGN CALLS THE ACCEPTANCE CRITERION FOR THIS WAVE NOW RUNS
(tests/dogfood.e2e.test.ts:926-1208). One fixture repository with all three
gates adopted and a frozen contract; one pull request that, in a single
commit, rewrites the contract's scope and its approval, adds
`severity_overrides` and `ignore: **` to vault-guard's config, adds an allow
entry to dep-guard's config, points conductor's own `command:` for the
secrets gate at a script the same commit adds, and carries a real-shaped
secret, a dependency name the committed fixture corpus does not know, and a
file outside the contract's scope. Without a trust base the run is green and
the pull request's own script has executed; with one, the script never runs,
all four control changes are reported as proposed, and the run blocks on the
secret, the dependency and the self-approval. It runs twice, once against the
sibling builds through `command:` and once against whatever is on PATH, and
the PATH half skips loudly when a binary is below its floor.

### The Action installs outside the tree, and the umbrella is one of the four

New in 0.4.0, and it closes the half of the boundary 0.3.0 left open. Every
rule above is about the GATE's program. THE UMBRELLA'S OWN BINARY WAS NEVER
CHECKED AT ALL, and the action ran it out of `node_modules/.bin/conductor`,
which is the head's own install: a pull request that repointed
`@vaultcompass/conductor` at a tarball it controlled, keeping the version
number, got its own umbrella and every rule in this section with it. Nothing
in this package could have caught that, because by then the compromised
program is the one doing the catching.

So the action installs, rather than checking that somebody else did
(action.yml, the `validate` and `install` steps). Four inputs name exact
versions, `conductor-version`, `dep-guard-version`, `vault-guard-version`
and `intent-guard-version`. `npm install -g` puts all four under the runner
temp, outside the workspace, and that directory's `bin` goes on `PATH`
through `GITHUB_PATH`; the run step then invokes `conductor` by name. The
pull request can rewrite its own lockfile, manifest and `node_modules`, and
none of them now decide which programs judge it.

WHAT THE PIN DOES NOT PROTECT, stated here because an earlier revision of
this entry claimed it did. That revision said the workflow file is read from
the base branch on a `pull_request` event and so the pin was "the protected
side". THAT IS FALSE. GitHub runs a `pull_request` workflow as it is in the
pull request's merge commit, and the first hosted run of this action was
its own counterexample: the adopter's pull request that bumped the action
pin ran under the bumped pin. Only `pull_request_target` runs the base
branch's copy, and that event hands the base's secrets to the pull
request's code, which is the wrong event for a gate over untrusted changes.
So a pull request that edits the workflow file can change the pins, or
remove the step, exactly as it can rewrite any other CI step. The boundary
this package draws is against the TREE choosing its own judge: policy from
the base ref, programs from outside the tree, base-approved or refused.
Against a workflow edit the only control is branch protection on the base
branch with review required for `.github/workflows`, and this package
neither provides it nor can. The README, the action's input descriptions
and its validate-step error text say the same thing in the same words, and
none of them may claim more than this.

EXACT VERSIONS ONLY, refused in a validate step against
`^[0-9]+\.[0-9]+\.[0-9]+$` before anything is fetched. A range or a
dist-tag would move the decision out of the workflow file and onto whatever
the registry served that morning, which is the same defect in a slower form.
`latest` is the case worth naming because it is the one somebody reaches for.

ANYTHING THAT READS action.yml PARSES IT, AND NEVER MATCHES LINES IN IT.
`scripts/lib/release-kind.mjs` reads all four `-version` defaults out of this
file to decide whether a tag is a package release or an action-only one, and a
hand-written line parser got that wrong twice. Searching for the input's name
anywhere landed inside a description that mentioned another input and read the
next input's default. Anchoring to `  <name>:` at the start of a line fixed
that and left a worse hole: every description here is a `>-` block scalar, so
a line of PROSE reading `default: 1.7.0` was taken as the key. That one is
reachable in the ACCEPT direction, which is the direction that cuts a Release
page for an action whose consumers die at `npm install -g`. The `yaml` package
is already a dependency and `tests/action.test.ts` already parses this same
file with it; a parser knows a key from the text of a block scalar, and knows
that `default: '1.7.0'` is the string `1.7.0`. Quoting a default here is
therefore safe, and adding a fifth input does not need a parser change.

THE INSTALL IS UNCONDITIONAL, on push and `pull_request` alike. A
conditional install would mean the action behaves one way on the runs that
matter and another way on every other run, and the second path is the one
nobody exercises before it is needed.

AND RESOLUTION STOPS LOOKING IN `node_modules/.bin` ON THOSE RUNS
(`skipNodeModules`, src/resolve.ts:185-206; `nodeModulesCandidate`,
src/resolve.ts:208-233; decided at src/gate-runner.ts:653-659). The version
probe takes the same skip (src/resolve.ts:251-257) because a probe RUNS the
binary, and so does the intent gate's preparation (src/run.ts:228-240), which
spawns that gate three times before `runGate` has looked at anything.
The remedy the program refusal has always printed, "install the gate on
PATH", is now what the action does for the adopter rather than advice.

THE PREPARATION TAKES THE PROGRAM RULE TOO, and an earlier wording here said
only that it "takes the same skip", which was presented as coverage it did
not have. The skip closes one location; it says nothing about a base policy
that vendors the intent gate in the tree through an absolute `command:`. That
shape ran the head's own rewritten program three times before the check the
whole boundary rests on had run once, and with `enforce: false` in the base
policy the run then exited 0. So the same check runs before the preparation
spawns anything (src/run.ts:409-423), through the same
`refuseHeadControlledBinary` and the same `gateProgramRefused` builder
`runGate` uses, and a preparation that FAILED under a trust base is enforced
(src/run.ts:454). Pinned by tests/intent-run.test.ts:769 (the head-rewritten
vendored program is never spawned and the run exits 2), 780 (enforced even
with `enforce: false` in the policy), 794 (a vendored program the branch left
alone still prepares), 807 (the same rewritten program runs as before with no
trust base), 843 and 858 (the preparation failure, enforced under a trust
base and read off the policy without one), and 884 (the node_modules half of
the skip, with a marker binary planted under `node_modules/.bin`).

AND WHAT IS VETTED IS EVERY PATH THAT WOULD BE SPAWNED, not only
`binary.program`. The version probe can resolve to a DIFFERENT file: a
per-command binary ignores `--version`, so resolution asks a version-safe
sibling found elsewhere (`versionProbeFor`, src/resolve.ts:238-262). Vetting
only the program left that second file unchecked, and a probe executes it as
thoroughly as a scan does. Both go through `refuseHeadControlledBinary`
(src/gate-runner.ts:351-366) and a refusal on either is the same outcome.
Pinned by tests/gate-runner.test.ts:774 and 794, where the program a base
policy names is unchanged and the sibling the probe would run is not.

THE SKIP IS NEVER SILENT, by the same rule that makes a withheld trust base
never silent: one `conductor/node-modules-skipped` notification per run at
NOTE level (`nodeModulesSkippedNotifications`, src/output-sarif.ts:809-845)
and one line in the full text report (`nodeModulesSkippedLine`,
src/output-text.ts:320-343), each naming every gate and the repository
relative path it declined. ONE FOR THE RUN, not one per gate: it is a
statement about the run's mode, and in the shape it happens in most, gates
installed as devDependencies and nothing else, it is true of all three at
once. A gate with nothing on PATH either is could-not-run under the
EXISTING `binary-missing` reason, with a sentence naming `npm install -g`
and that product's own action input appended (`missingGateRemedy`,
src/gate-runner.ts:541-571). A new reason would have been wrong: nothing
was found, which is what `binary-missing` has always meant.

OUTSIDE PULL-REQUEST MODE NOTHING CHANGES. A pre-commit hook and a direct
run on your own checkout are already inside the boundary, and the
repository's own pin still wins there, which is what `pnpm exec` does in
the same repository.

Pinned at three levels, and the parity direction is pinned at every one of
them, because a skip that also fired on ordinary runs would silently change
what a hook executes. The resolution decision:
tests/resolve.test.ts:244-363. The gate: tests/gate-runner.test.ts:591-702,
where each case plants a marker binary under `node_modules/.bin` so "the
other one ran" is a fact about the filesystem rather than about a `source`
field. The reports: tests/output-text.test.ts:1090-1143 and
tests/output-sarif.test.ts:1787-1841. Through the CLI on a real repository:
tests/cli.test.ts:1597-1620, where the same plant that 0.3.0 refused is now
unreachable AND the real gate on PATH reports the secret it was hiding. End
to end against the real gates: tests/dogfood.e2e.test.ts:662-776, which
plants two marker binaries in the dogfood clone's own `node_modules/.bin`,
and the composed test's PATH variant asserts the line is ABSENT
(tests/dogfood.e2e.test.ts:1203), which is what keeps it from being
decoration that appears on every run. The action itself:
tests/action.test.ts:230-432, which RUNS both scripts under bash with npm
replaced by a recorder rather than pattern-matching the YAML.

WHAT THIS STILL DOES NOT DO, stated here because a reader should not infer
more coverage than there is:

1. KNOWN-OPEN: THE INTENT GATE'S IMPORTED-CONTRACT PATH IS OUTSIDE THE
   BOUNDARY. When a repository has no frozen contract and a spec is imported
   instead, that spec is a file in the HEAD tree, so the contract the gate
   judges against is derived from something the pull request controls. A
   pull request that adds or edits its own spec is therefore choosing part
   of what it is judged by, and neither the base-ref rule nor the program
   rule closes that: the flag is deliberately withheld in that case, because
   the imported contract lives in a temporary directory with no repository
   in it, and the withholding is reported like any other. This is listed
   again in the "what is NOT pinned" section at the top so an audit meets it
   without reading this far. The workaround, not the fix, is that a
   repository wanting the boundary freezes a native contract and keeps it
   committed; the fix is to read the spec from the base ref too, and it is
   not in this release.

## The intent gate's own reasons are classified by prefix, and every prefix is a liability

The intent gate can block for reasons that are neither a budget violation
nor drift, and it pushes all of them into one `reasons` array with nothing
structured saying which is which. So the umbrella matches them by PREFIX,
copied from that gate's own source (`GATE_STATE_REASON_PREFIXES`,
src/normalize.ts:453-464). Five kinds today: an invalid contract, a missing
one, an unfrozen one, and the two pull-request-mode refusals 1.4.0 added.

TWO DEFECTS OF THIS DESIGN HAVE NOW BOTH HAPPENED, and both were silent,
which is why the mechanism is written down here rather than left in a
comment.

1. A PREFIX GOES STALE WHEN UPSTREAM REWORDS. The no-contract sentence
   interpolates the state directory name, and intent-guard 1.3.0 renamed
   that directory. The umbrella matched only the old spelling, so from
   1.3.0 onward the classifier was DEAD: a no-contract block was filed as
   the unattributed backstop instead of `contract-missing`, and the SARIF
   details said `unattributed` where a consumer filters on the kind. Fixed
   in 0.3.0 by matching both names, canonical first, which is the order the
   umbrella already uses when reading the two state directories. Pinned by
   tests/normalize.test.ts:483-538.
2. AN UNCLASSIFIED REASON DISAPPEARS FROM THE REPORT WHEN SOMETHING ELSE
   BLOCKS. The backstop that catches unclassified reasons fires only when
   NOTHING ELSE blocked (src/normalize.ts:660), so a pull request that
   forged a contract approval AND breached a change budget reported only
   the budget breach. The run still failed; the report never said the
   approval was self-granted, which is the one sentence pull-request mode
   exists to produce. Found by running the real 1.4.0 gate against a
   crafted pull request rather than by reading the code, which is the only
   way this class of defect surfaces. Fixed by classifying both refusals.
   Pinned by tests/normalize.test.ts:589, which puts a self-approval
   refusal and a budget violation in one run and asserts both survive.

The prefixes are enumerated against the real strings in
tests/normalize.test.ts:384-419 and 540-762, so an upstream rewording turns
a test red rather than dropping a reason out of every report. That is the
whole of the defence, and it is only as good as somebody re-running it
against a new gate release.

## Gate resolution: the name outranks the location, and the location outranks nothing

Resolution loops over CANDIDATE NAMES on the outside and LOCATIONS on the
inside (src/resolve.ts:346-366, with `locate` at 185-206). The obvious
loop is the other way round, and it pins a repository to whatever name
happens to be global: a machine with a leftover pre-rename install on PATH
would beat the repository's own current-name dev dependency, silently, for
as long as the old package stayed installed.

Within one name, the repository's own `node_modules/.bin` beats PATH
(src/resolve.ts:195-200). This was the other way round until a dogfood run
found a global gate build running over a repository's own pinned one, with
the report naming a version that repository had deliberately not chosen.
`pnpm exec` in the same repository runs the pin, and the package manager
is the one the lockfile agrees with.

The two orderings are opposite on purpose. A NAME is a statement about
which product, and the repository has no say in that. A LOCATION is a
statement about which build, and the repository does.

AND ON A PULL-REQUEST RUN `node_modules/.bin` IS NOT A LOCATION AT ALL,
because there the repository making that statement about which build is the
pull request. That is rule 1c in the source comment, it is decided by the
caller rather than here (`skipNodeModules`, src/resolve.ts:185-206) and it
is described in full in the trust-boundary section above. Nothing else in
this section changes on such a run: the name ordering, the `command:`
override and the version probe are the same, and the probe takes the skip
too because a probe runs the binary.

A `command:` in the policy overrides resolution entirely. It must be an
absolute path, refused at parse time otherwise, because a bare name would
be resolved against PATH, which is what resolution already does
(src/policy.ts:332-338). A configured command that is not a file THROWS
rather than falling back, because the user named one specific file and
running something else would run a different tool than the one they asked
for (src/resolve.ts:290-296). A configured `.js` file without the
executable bit is run through this same Node, which is what its shebang
asks for (src/resolve.ts:303-327).

There is no npx fallback, deliberately. It would make what ran depend on a
package cache the report cannot describe, and a gate that ran from an
unknown version is worse than one honestly reported missing.

Only a binary the candidate table marks version-safe is asked
`--version`. The per-command binaries shipped before their product's 1.2.0
ignored the flag and RAN THE GATE against the current directory instead,
so a probe there would have side effects on the user's repository. When
the resolved binary is one of those, the unified binary of the same
product is resolved separately and asked instead, and when that is not
installed either the version is reported unknown rather than guessed
(`versionProbeFor`, src/resolve.ts:236-260, driven from the candidate
table's `versionSafe` field at src/resolve.ts:113-126).

THIS IS BELT AND BRACES AGAINST A CLASS OF BUG, NOT A LIVE HAZARD, and
the difference matters to anyone deciding whether the fallback still
earns its keep. No published version under the names this file resolves
has the bug: the fix is the commit v1.2.0 points at, only 1.2.0 and 1.2.1
were ever published under these names, and the releases that had it were
the pre-rename packages the resolver already refuses to resolve at all
(the comment at src/resolve.ts:116-121 says which, and
tests/resolve.test.ts:130 pins the refusal). An earlier draft of this file
said the fix was merged upstream but unpublished, which had stopped being
true; the source comment at src/resolve.ts:40-55 is the corrected one.

It is kept anyway, because it costs one field on a candidate and a
fallback nobody exercises, and because the failure it prevents is silent
and happens in the user's own repository rather than in this one.

Pinned by tests/resolve.test.ts:64 (repository pin over global install),
80 (current name over older name wherever each is installed), 112 (null
rather than a guess), 130 (a binary literally named conductor never
satisfies the intent gate), 146, 159, 166 and 177 (the `command:`
override and its refusals), 188, 199 and 211 (the version probe: the safe
binary is probed, the per-command one is never probed, and the unified
binary of the same product is probed in its place), and by
tests/policy.test.ts:141 for the absolute-path rule. The candidate table
itself is pinned at tests/resolve.test.ts:232 and 239.

## The policy file is a passthrough, and the reserved list is the only exception

Gates are keyed by the ROLE they fill, and the product filling it is a
field inside (src/policy.ts:41-45, and the shipped schema). A product
rename or a swap is then a one-line edit rather than a rename of the key a
repository wrote its CI around. A policy that puts a product in a role it
does not fill is rejected at parse time, because the failure mode of
accepting it is confusing rather than loud: the secrets section of the
report would carry dependency findings (`PRODUCT_FOR_ROLE`,
src/policy.ts:90-94, enforced at src/policy.ts:314-319).

There is deliberately no shared severity threshold. Two of the three
products share a four-level scale; the third scores a weighted rubric from
0 to 100 and has no per-finding severity at all. A top-level `failOn`
would read as one decision and mean three different things, so the schema
refuses it outright rather than ignoring it. Each gate keeps its own
threshold in its own `options` block, spelled the way that gate spells it.

`options` keys are the gate's own long-flag names with the dashes
stripped, and this package never maps, renames or interprets one
(`renderOptionFlags`, src/policy.ts:448-468). `true` renders as `--key`,
`false` as `--no-key` (commander's own convention, and the one negation
rendering that is right without knowing the flag), a scalar as `--key
value`, and an array as one pair per entry. Keys are sorted, so two policy
files differing only in key order produce the same command line and a
diffable report. That passthrough is what keeps the umbrella from growing
a second, drifting copy of three CLIs, and it is why a gate can gain a
flag without this package needing a release.

Pinned by tests/policy.test.ts:36 (keyed by role), 121 (a product in the
wrong role is rejected), 131 (a top-level `failOn` is refused outright),
161 (each threshold stays in its own block), 170 (the four renderings:
`--key`, `--no-key`, `--key value`, and a scalar), 177 (an array renders
once per value), 181 (key order does not change the command line) and 187
(a key spelled with its dashes is rejected).

The one exception is `RESERVED_OPTIONS` (src/policy.ts:102-128): the
handful of keys the umbrella writes itself are refused, because two
writers of one flag is a fight the user would have to debug from a stack
trace. Pinned by tests/policy.test.ts:196.

Three keys are reserved for a different reason and each gets its own
message, because a rejection that gives the wrong reason sends somebody
looking in the command line for a flag the umbrella never writes, finding
nothing, and concluding the rejection is a bug in this tool
(`reservedReason`, src/policy.ts:239-274):

- `base` on the intent gate, because the umbrella computes the change set
  itself and passes `--paths`, and a `--base` inside the gate would be
  resolved against a `--project` that may be a temporary directory with
  no repository in it (src/policy.ts:248-255). Pinned by
  tests/policy.test.ts:211 and 231, the second of which asserts the
  message names `--paths`.
- `base` on the dependency gate, because the umbrella passes `--staged`
  and a policy-supplied base would fight it (src/policy.ts:256-262).
  Pinned by tests/policy.test.ts:258, which asserts the message names
  `--staged`.
- `format` on the secrets gate, because the umbrella writes that option
  under its SHORT name, `-f json` (src/policy.ts:263-269). Pinned by
  tests/policy.test.ts:244, which asserts the message names `-f`.

The last two were recorded here as the prose giving the wrong reason: the
generic sentence said "the umbrella passes that flag to this gate
itself", which is false of both. The code was the wrong one and both
messages have been rewritten.

THE PAIRING IS NOW HELD IN ONE DIRECTION BY DERIVATION AND IN THE OTHER
BY HAND, and which is which is the whole of the guarantee
(tests/policy.test.ts:286-367). `flagsWritten` calls `gateArgs`
(src/gate-runner.ts:423-488, exported for exactly this) over the four
shapes of run there are and collects every token starting with a dash. So
the DANGEROUS direction is derived: tests/policy.test.ts:347 asserts that
every flag `gateArgs` writes is in `RESERVED_OPTIONS`, and a flag added
to `gateArgs` and forgotten in the list turns that test red rather than
letting a policy file write the same flag a second time.

The other direction cannot be derived, because the three keys above are
reserved WITHOUT the umbrella writing them. Those are listed by hand in
`RESERVED_WITHOUT_WRITING` (tests/policy.test.ts:334-345) and held to
exactly those three by tests/policy.test.ts:356, so a fourth cannot be
added without somebody writing down why. That list is still hand
maintained, but it is three entries long rather than the whole table, it
is held against the derived set rather than restated beside it, and each
of its three has its own message test above.

## Stages are cumulative, and a gate the filter holds back is never resolved

`GATE_STAGES` is one ordered array and the order is the whole rule
(src/policy.ts:56). A gate runs at its own stage and at every later one,
so a run at `ci` runs everything enabled (`runsAtStage`,
src/policy.ts:76-78). Adding a fourth stopping point is an entry in that
array and nothing else.

Defaults are per role: `commit` for dependencies and secrets, `ci` for
intent (src/policy.ts:69-73). Runtime is not what decides this. All three
together take under a second on a staged commit; the cost is CEREMONY, and
only the intent gate has any, because it wants a contract approved before
the work starts. A secret that reaches a pull request is already on a
remote, so the earliest stage is the only honest place for that one.

The protective half is about what a held-back gate never reaches, and it
is worth saying exactly rather than loosely. The partition itself is one
filter over the enabled list, taken before the run loop starts
(src/run.ts:260-271). Resolution is NOT hoisted out of the loop: each
surviving gate is resolved one at a time inside it, by `runGate`
(src/run.ts:465-483, resolving at src/gate-runner.ts:664). What the
filter guarantees is therefore about the gates it holds back, not about
the ones it keeps: A GATE THE FILTER HELD BACK NEVER REACHES RESOLUTION
OR SPAWN AT ALL, because it never enters the loop. A gate that will not
run at this stage must not be able to fail the run by being uninstalled
here, and an intent gate that lives only on the CI image is the ordinary
case rather than an error.

An earlier wording here said the partition happens "before any binary is
looked for", which is true of the filter and invites the reading that
resolution is hoisted. It is not, and a future change that moved
resolution above the loop would break exactly this rule while still
satisfying that sentence.

A deferred gate is recorded rather than dropped (`DeferredGate`,
src/run.ts:32-37). It is deliberately not a `GateOutcome`: no binary was
looked for, nothing was spawned, and there is no exit code to report. It
still has to be visible, or a run at `commit` reads exactly like a run
that checked everything.

Pinned by tests/policy.test.ts:370, 376, 382 and 388 (the cumulative rule
and the stage order); tests/run.test.ts:219, 224, 229 and 244 (which
gates run at each stage, and an explicit stage over the role default),
299 ("does not treat a deferred gate as a missing one", which runs with
an empty PATH and an empty repository root and still gets exit 0 and no
findings, so nothing was looked for), 268 ("never lets a deferred gate
reach the exit code"), and 367 (a disabled gate is not also reported as
deferred); and end to end by tests/cli.test.ts:191, 205, 217 and 242.

## A gate `--gate` left out is recorded, not silently dropped

Added after this file was first written, and it is the same rule as the
deferred gate one applied to a different cause. `--gate secrets` narrows a
run, and before this the narrowing left no trace: an uploaded log from a
`--gate` run was indistinguishable from a log of a full one, which is
exactly the confusion the deferred notification exists to prevent.

The two facts are kept apart deliberately. A gate the POLICY FILE disables
is a standing decision somebody wrote down and is not news. A gate the
COMMAND LINE left out was on in the file and did not run this once. So
`excludedByCli` is set only for a gate that WAS enabled and is not now
(`GatePolicy.excludedByCli`, src/policy.ts:145-156, set at
src/policy.ts:419-428 and initialised false at parse time,
src/policy.ts:351-353). Pinned by tests/policy.test.ts:415 (the gate
`--gate` switched off is marked and the named one is not), 428 (a gate the
file had already disabled is NOT marked, or the user's own decision is
read back to them as something the command line did) and 438 (nothing is
marked when there was no `--gate` at all).

It is carried on the run result as `ExcludedGate` (src/run.ts:39-53),
read off the POLICY rather than off the enabled list, because these gates
are exactly the ones the override took out of that list, and in role order
so the report never depends on the order the flags were typed
(src/run.ts:273-278). Like `DeferredGate` it is deliberately not a
`GateOutcome`: no binary was looked for and there is no exit code to
report. Pinned by tests/run.test.ts:320 (both excluded gates are carried,
with only the named one running), 338 (nothing excluded without `--gate`)
and 347, which is the one that matters: a `--gate` run gets the SAME exit
code a policy declaring only that gate would, so reporting the excluded
gates never gives them a vote. That test stubs an excluded gate that would
have blocked, so the two numbers would differ if any of this reached
`composeExitCode`.

Both formats say it. One line in the text report
(src/output-text.ts:284-289), a clause on the one-line summary of a clean
run (src/output-text.ts:644-649), and a `conductor/gate-excluded`
notification in the umbrella's SARIF run
(src/output-sarif.ts:600-608). A notification rather than a result by the
discriminator below: nothing went wrong, and how much of the policy a run
covered is a statement about the run. Pinned by
tests/output-text.test.ts:734 (the full report names them and says
`--gate`), 747 (the clean run's single line still names them) and 756
(silence on a run that had no `--gate`, verbose or not); and by
tests/output-sarif.test.ts:149 (a notification and not a result, at note
level, naming the role and the flag) and 171.

## The hook: one hook, one command, one exit code

`conductor init` writes exactly one pre-commit hook, and it runs the
umbrella once rather than three gates (src/init.ts:467-548). It runs
`conductor run --staged --stage commit`, not every stage: a pre-commit
hook IS the commit stopping point, and running the intent gate's ceremony
there is what makes a team switch the hook off.

The exit code is passed through unchanged (src/init.ts:547). The hook
written the natural way, `if conductor run; then exit 0; fi; exit 1`,
collapses 2 into 1 and so reports findings that were never looked for.
There is one message per code and not one message for both
(src/init.ts:534-543), because calling exit 2 a blocked commit describes a
decision nobody made.

Neither message mentions a bypass flag, in any branch. Every gate already
has a recorded, reviewable, scoped escape: an allow entry, an ignore path,
a baseline, or `enforce: false`. A bypass skips every gate invisibly,
including the ones that would have caught something unrelated to the
finding somebody disagreed with.

The hook has no `set -e` of its own and is written to survive somebody
else's, because husky's dispatcher runs it as `sh -e` and under `-e` the
shell exits at the failing command before its status can be captured,
which keeps the exit code and loses the line that explains it.

Two strings in the source used to contradict this: `conductor init`'s own
command description and the adopt guidance both said the hook runs "every
enabled gate", when it runs the commit stage, so a gate whose stage is
`ci`, which is the intent gate's default, is deferred rather than run.
The README said it correctly in its stages section and incorrectly in its
opening summary. All three now say the commit stage
(src/cli.ts:254-256, src/init.ts:1011-1017, README.md:31-33).

The hook is written with the executable bit set after the write rather
than through the write's mode option, because an existing file keeps its
own mode when written through and git will not run a hook it cannot
execute (src/init.ts:1345-1351).

Pinned by tests/init.test.ts:236 (one hook, running the umbrella and not
three gates), 247 (`--stage commit` is in the hook text), 1154 and 1333
(a real commit through husky 9's dispatcher and through husky 8, not a
fixture), 1468 to 1566 (fail closed), 1583 (`sh -e`: the explanation
survives, which is the half `-e` destroys), 1605 (the exit code passed
through: a stub conductor exits 2 and the hook exits 2), 1622 (a clean
run commits), 1649 to 1698 (one message per code, each taken by running
the generated script against a stub rather than by reading the template)
and 1701 (no bypass advertised in either the native or the husky hook).

## What init refuses to touch

Six refusals, each returning early with a conflict and writing nothing:

A foreign hook is never replaced (src/init.ts:1206-1211). That hook is
somebody's working setup and init has no standing to have an opinion about
it. A whitespace-only file is treated as absent rather than foreign
(src/init.ts:1206), pinned by tests/init.test.ts:1031. The refusal itself
is pinned by tests/init.test.ts:961.

Another gate's own pre-commit hook is reported and left alone unless
`--adopt` is passed (src/init.ts:1212-1226). Adding the umbrella's hook
alongside it would run that gate twice and report its findings twice.
`--adopt` replaces it and stores the original in the manifest so revert can
put it back. Pinned by tests/init.test.ts:986, a parameterised case over
all three gates' own hooks, and by 1004 and 1019 for the adopt-and-restore
pair. `--adopt` never touches a FOREIGN hook, pinned by
tests/init.test.ts:973.

A hook generated by lefthook or by the pre-commit framework is left alone
and the user is told the stanza to add to that manager's own config
(src/init.ts:1084-1094, guidance at 240-253). Those managers rewrite the
file on every install, so anything written there is lost without a word,
and the guidance says out loud that the manager owns the commit's exit
code so the umbrella's 1 and 2 do not survive it. Recognition is by
strings captured from real installs, kept as fixtures under
tests/fixtures/hooks, and the code comment records honestly that the
`lefthook_version:` alternative recognises nothing any live version writes
and is kept only because a spare alternative in an OR cannot cause a false
negative (src/init.ts:213-227).

The BEHAVIOURAL pin is tests/init.test.ts:1425, a parameterised case that
writes each captured file into a real repository, runs init, and asserts
the conflict, the manager it was classified as, and that nothing was
written. That is the test to keep. Two others beside it assert only what
is IN the captured text, that lefthook's real hooks carry `call_lefthook`
and never `lefthook_version:` (tests/init.test.ts:1448) and that the
pre-commit framework's marker line is character for character the string
init.ts looks for (tests/init.test.ts:1460). Those two are worth having,
because they are what would catch an upstream rewording, but neither one
runs init, so neither is evidence about what init does with the file.
The pair at tests/init.test.ts:1382 and 1401 exercise the same refusal
against HAND-WRITTEN approximations, which proves only that the code
agrees with whoever wrote the approximation.

A repository wired to simple-git-hooks or yorkie is refused too, with the
separate conflict `managed-hooks` (src/init.ts:1112-1128, recognition at
255-288, guidance at 399-448). It is separate from `generated-hook`
because the remedy is: those two keep the hook TEXT in a declaration
rather than in a config file the generated hook points at, so there is no
file to name a stanza in, and the guidance names the entry to edit
instead.

THE DECLARATION IS A SIGNAL IN ITS OWN RIGHT, not corroboration of the
hook's contents (`declaredManagedHooks`, src/init.ts:330-378, the exact
config-file list at src/init.ts:137-146). It is the
only signal that exists on a fresh clone, where the manager has never run
and `.git/hooks/pre-commit` does not exist yet, which is exactly the state
somebody adds the umbrella in. It is also the only signal at all for
simple-git-hooks 2.8.0, whose generated hook is the shebang and the user's
own command and contains no string belonging to simple-git-hooks; no
content rule can recognise that file at any price.

The declaration is the `simple-git-hooks` or `gitHooks` key in
package.json, and for simple-git-hooks also any of the standalone config
files its own README lists. That list is EXACT
rather than a prefix or extension test, so a `simple-git-hooks.yaml` is
somebody's notes and not a reason to refuse an install. The combination
needing all three signals is real rather than hypothetical: a standalone
config file plus a version old enough to write no marker is invisible to
both of the others.

Presence is the whole test and is deliberately not narrowed to a declared
`pre-commit` entry, because yorkie's installer writes every hook file
whatever the key contains and simple-git-hooks removes hooks it previously
managed. The cost of the wide rule is a refusal somebody has to read; the
cost of the narrow one is a hook silently deleted.

THE GUIDANCE NAMES THE FILE THE DECLARATION IS ACTUALLY IN, which is why
the detection carries WHERE it fired rather than just which manager
(`ManagedDetection`, src/init.ts:320-328). simple-git-hooks resolves
package.json LAST, so while a standalone config file exists an entry added
to package.json is exactly the one it ignores: guidance naming package.json
there would send somebody to edit a file that will not be read and leave
them with the umbrella uninstalled and no error to explain it. The config
files are checked before package.json for the same reason, in the same
order the tool resolves them. Pinned by tests/init.test.ts:1956.

THE REFUSAL FIRES ONLY WHERE GIT ACTUALLY RUNS `.git/hooks`
(`hooks.isDefault`, src/init.ts:782-792, used at src/init.ts:1116). Both
managers write that directory and neither reads `core.hooksPath`, so under
husky or any other configured hooks directory the file they rewrite is not
the file git runs: the umbrella's hook is in no danger from them, and
refusing would name a file the manager never touches while blocking an
install that is safe. The test compares the RESOLVED directory against the
git directory's own `hooks/` through `realpath` (`samePath`,
src/init.ts:830-839) rather than asking whether `core.hooksPath` is set,
because a repository may set it to exactly where git already looks, and a
rule phrased as "nothing is configured" would answer differently for two
repositories git treats identically. The realpath matters on macOS, where
the temporary directory is a symlink and the two sides of that comparison
arrive by different routes.

INIT DOES NOT OFFER TO WRITE THE ENTRY, and `--force` does not override
the refusal, which puts it with `foreign-hook` and `gate-hook` rather than
with `changed-since-init`. Init writes a hook, a policy file and a
manifest, and the manifest is what makes `--revert` honest; an edit merged
into somebody's package.json has no revert story that is not a guess about
which of their later edits were theirs. The guidance says a later release
may offer to, and says to put the umbrella LAST and as its own command
rather than chained behind `&&`: a chain stops at the first failure, so an
umbrella in front hides the other command's verdict and one behind an `&&`
never runs once anything ahead of it fails.

Pinned by tests/init.test.ts:1822 (the bare clone: the key alone, with no
hook file, for both managers), 1843 (`--force` and `--adopt` together do
not override it), 1854 (the same refusal under `--dry-run`, with no
actions), 1864 (the file each tool really wrote, with no package.json at
all, over three captured fixtures), 1890 (a custom `core.hooksPath` takes
both managers out of play and init says nothing about them), 1912 (setting
`core.hooksPath` to the default `.git/hooks` does NOT, which is what makes
the rule a path comparison rather than a "is it configured" test), 1931 (a
standalone config file alone, parameterised over all eight the README
lists), 1972 (a `simple-git-hooks.yaml` is not one of them), 1983 (a
package.json with neither key takes the native path and init writes
normally), 1995 (a package.json that will not parse is no declaration
rather than a throw) and 2005 (the guidance names the command, says
conductor does not edit package.json, and mentions `--force`). Four more
assert what is IN the captures rather than what init does with them: 2024,
2030 (2.8.0 carries no marker at all, which is the finding the declaration
rule rests on), 2040 and 2046 (the `exit 1` wrapper behind the claim the
guidance makes to a yorkie user about the umbrella's exit 2).

A `core.hooksPath` pointing outside the repository is refused
(src/init.ts:1051-1062). Writing there would install this repository's hook
on every repository on the machine. Pinned by tests/init.test.ts:1071.

An existing policy file is never rewritten (src/init.ts:1260-1268). It is
the one artifact a user edits by hand. Pinned by tests/init.test.ts:380.

One resolution rule underneath all of these: a RELATIVE `core.hooksPath`
resolves against the WORKING-TREE ROOT, not against the `.git` directory
(src/init.ts:808-813). A sibling tool resolved it against the `.git`
directory and the test covering the case asserted the same wrong location,
so the two agreed with each other and neither was ever checked against
git. The test here drives a real commit instead
(tests/init.test.ts:1041).

## The husky rule is structural, and content is never a signal

Where git looks and where the hook a human maintains lives are not always
the same file. husky 9 sets `core.hooksPath` to `.husky/_`, a generated
and gitignored directory it rewrites on every install, and the file git
executes there is a dispatcher that execs the TRACKED hook one directory
up.

The recognition rule is the SHAPE of the path and nothing else: the hooks
directory is named `_` and its parent is named `.husky`, both halves
required (`huskyDirectoryFor`, src/init.ts:188-197). Only husky creates
that path. The tracked target is that `.husky` directory's own
`pre-commit`, never a computed parent of whatever directory git happens to
point at (src/init.ts:1133).

Two things are deliberately excluded from the rule, and each cost a bug.

THE CONTENT of the executed file is not a signal. The line that sources
husky's shim appears in two completely different places: under husky 9 the
file at `.husky/_/pre-commit` is a dispatcher, and under husky 8
`core.hooksPath` is `.husky` and the file there IS the tracked hook with
the shim as a preamble. Reading content therefore fired against husky 8's
tracked hook, and "one directory up" then pointed at the parent of
`.husky`, which is the repository root. Init wrote a hook there, never
read the real one so never saw the gate hook in it, reported success, and
left every commit ungated. The structural rule excludes husky 8 on its
own, because there the hooks directory is `.husky` and not `_`.

THE PRESENCE OF THE SHIM is not a signal either. Requiring it looks like
useful confirmation and quietly reintroduces the original trap: husky
gitignores `.husky/_`, so `git clean -xdf` deletes the whole directory
while `core.hooksPath=.husky/_` survives in `.git/config`. In that state
there is no shim and nothing to confirm, so a shim requirement sends init
down the ordinary path to write the very file husky's next prepare step
wipes. The shim is evidence that husky ran recently, not evidence about
whose directory this is, so it is REPORTED in the dry-run detail line and
never TESTED against (src/init.ts:199-202 and 1230-1243).

The husky redirect is decided before the generated-hook detection runs
(src/init.ts:1078-1081), so a husky dispatcher is never misread as
lefthook's or the pre-commit framework's.

Pinned by tests/init.test.ts:1101 (the tracked hook, not the dispatcher,
decides what is there), 1114 and 1139 (adopts the tracked hook, leaves
the dispatcher alone, restores byte for byte), 1154 (a real commit
through the dispatcher), 1188 (survives the reinstall that rewrites the
generated directory), 1210 (redirects on the path alone with no shim),
1234 (redirects after a clean), 1248 (survives the install that
repopulates a wiped generated directory), 1273 (does not redirect out of
a generated directory that is not husky's), 1301, 1314 and 1333 (husky 8
takes the native path, and a real commit proves it), and 1355 (a
dispatcher-shaped hook sitting in the ORDINARY hooks directory is foreign
rather than a reason to write somewhere else).

## The digest ladder: the marker says whose, the digest says which version

A hook carrying the umbrella's marker used to end the matter, and that was
a bug with a long fuse: a hook an OLDER conductor wrote carries the same
marker, so it was skipped for ever. It kept running that version's command
line after the hook text changed, and it never entered the new manifest,
so a later `--revert` walked past it and left it behind.

So the marker settles WHOSE hook this is, and the digest decides the rest
(src/init.ts:1144-1205), in four rungs:

- The installed bytes equal this version's hook. Nothing is written. If
  the manifest does not record that digest, the hook is RECORDED anyway,
  because a file init put there but cannot prove it put there is one
  revert walks past. A `git clean`, a deleted `.guardrails` directory and
  an install from before manifests existed all land in that state.
- The installed bytes equal what the manifest says a previous init wrote.
  Nobody has touched it, so it is the umbrella's to replace, and it is
  rewritten as an upgrade.
- `--force` was passed. It is replaced whatever it says.
- Anything else, which includes having no manifest to check against. The
  marker says it started as the umbrella's; the digest says it is not any
  more, and an edited hook is somebody's working setup whatever comment
  sits at the top of it. Conflict, nothing written.

Pinned by tests/init.test.ts:437, 454, 476, 543, 561, 570, 589, 610, 623,
636 (no manifest at all treated the same way) and 1728 to 1787, which
drive the upgrade using the captured previous hook body in
tests/fixtures/hooks, with tests/init.test.ts:1755 guarding the fixture
against drifting into being what init writes today, which would make
every assertion in that block pass for the wrong reason.

## The manifest is what makes revert honest

Without a record, "undo the init" means guessing which files were the
tool's, and a tool that guesses about deletion in somebody's repository
has to be wrong only once.

The manifest records each file's path, its sha256 and its KIND
(src/init.ts:643-658). The kind is recorded rather than inferred from the
path, because revert's whole decision turns on whether the HOOK survived
and sniffing that from a filename is a guess.

A rewrite carries forward everything a previous manifest held that this
run did not rewrite (src/init.ts:1365-1376). An upgrade rewrites the hook
and nothing else, so a manifest built purely from this run's writes would
forget the policy file it wrote last time. It also carries forward the
adopted hook, and that one matters more: the manifest is the ONLY copy of
the gate hook `--adopt` replaced, so forgetting it makes that hook
unrestorable (src/init.ts:1302-1313).

Pinned by the tests that actually OPEN the manifest and read the fields
this section is about: tests/init.test.ts:454 (the hook entry's kind and
sha256 are the new hook's, and not the old digest still sitting there),
543 (a lost manifest is rebuilt with a hook entry carrying the digest of
the file on disk), 488 (the policy entry survives an upgrade that
rewrote only the hook) and 499 (the adopted hook survives one). The
restore side is pinned by tests/init.test.ts:835, which reads
`adopted.content` back out after a partial revert.

Not by tests/init.test.ts:259, which this file used to cite first. That
test inits and then reverts and asserts the hook file is gone; it never
opens the manifest, so it is evidence that the round trip works and no
evidence at all about what the manifest records. It is the clearest
example in this file of a citation that reads right from the test title
and proves something adjacent to the claim beside it.

## What revert guarantees

Revert removes exactly what init wrote and nothing else. Four rules, and
all four were bugs here first.

IF THE HOOK SURVIVES, NOTHING IS REMOVED. Files are classified first and
acted on second (src/init.ts:1524-1533), and a hook that has changed
since init wrote it returns before the removal loop is ever entered
(src/init.ts:1535-1557), because deciding as it went is what let the old
version remove the policy file before discovering it could not remove the
hook. Removing the policy file while leaving an edited hook in place
leaves that hook running the umbrella with nothing to read, so every
commit afterwards is refused with exit 2, while revert reported success.

Pinned in BOTH directions now. tests/init.test.ts:751 asserts the policy
file and the hook are both still there, which is the specific pair that
caused the incident. tests/init.test.ts:766 asserts the guarantee itself
rather than a list of paths: no action on the result is a `remove` and
every one is a `skip`, so a file added to what init writes is covered
without anybody remembering to come back to this test.

A CHANGED FILE IS LEFT ALONE AND REPORTED (src/init.ts:1568-1577). That
file is now the user's whatever it started as, and a revert that deletes
edited work is a revert nobody runs twice. Pinned by
tests/init.test.ts:724 (an edited policy file survives and the run is not
a success) and 798 (the conflict says `changed-since-init` and names
`--force`).

THE MANIFEST OUTLIVES A PARTIAL REVERT (src/init.ts:1631-1675). It is
deleted only once it holds nothing, because it is the only record of what
is left and, after an `--adopt`, the only copy of the replaced hook. The
`.guardrails` directory goes with it only when it is empty, using
`rmdirSync` rather than `rmSync`, and when it is not empty that is
REPORTED rather than passed over (src/init.ts:1636-1673). Pinned by
tests/init.test.ts:784 (the manifest survives and still holds entries),
681 (the directory goes with the last file), 693 (it stays, and is
reported as skipped, when somebody else's file is in it) and 714 (it is
reported as removed when it went).

A PARTIAL REVERT IS NOT A SUCCESS. It returns `ok: false`, so the exit
code is non-zero and a script does not read "some of it" as "all of it"
(src/cli.ts:294), and the human rendering goes to stderr rather than
stdout so a pipe cannot carry it past the reader who needed it
(src/cli.ts:288-293).

AN ADOPTED HOOK IS NOT WRITTEN BACK WHILE THE UMBRELLA HOOK SURVIVES, or
the user ends up with two hooks at one path and the edit they asked to
keep is gone. Pinned by tests/init.test.ts:851, which edits the umbrella
hook after an `--adopt`, reverts, and asserts the file on disk is still
the edit and that no action on the result is a `restore`. That test
exercises the changed-hook early return below, not the `umbrellaHookGone`
condition itself: an edited umbrella hook is a `changed` hook, so revert
refuses before the condition is ever read. The positive
half, that the gate's own hook does come back once the umbrella hook is
gone, is pinned at tests/init.test.ts:870 (under `--force`), 883 (the
hook deleted by hand, on a revert too partial to finish) and 908 (without
`--force`, when the umbrella hook was never touched).

THE FLAG THIS FILE USED TO POINT AT HAS BEEN REMOVED. The restore used to
be guarded by a `hookRemoved` boolean raised while removing files, and
that guard was dead defence: a manifest that records an adoption also
records the hook init wrote in the same run, and every path that reached
the restore with a hook entry in the manifest had already set the flag.
The hook was either gone, removed, or removed under `--force`; the one
remaining case, a hook that changed with no `--force`, returned at the
changed-hook check long before. So the changed-hook early return was what
actually held the guarantee, and a refactor that kept the flag while
flattening that return would have satisfied the flag and broken the rule.

The condition is now read off the world rather than off the flag: the
manifest records at least one hook, and no path it records is on disk any
more (src/init.ts:1601-1614). That is a statement about what is there,
which is what the rule is about, so a future refactor of the early return
cannot restore a hook next to a surviving one. The flag is gone rather
than kept as a second line, because two conditions that must agree are a
place for them to disagree.

One test now reaches `umbrellaHookGone` rather than short-circuiting
before it: the dry-run adopt revert (tests/init.test.ts:2212) reaches it in
the matched state, where there is no changed hook to refuse at the early
return. Every OTHER state a test constructs still short-circuits at the
changed-hook early return (src/init.ts:1557) first: a changed hook refuses
there directly, and a hook that is gone, matched, or force-replaced reaches
the condition only after the early return has already let it through, so in
real mode the condition and the flag it replaced agree either way, which is
why the real-mode `existsSync` derivation is defence in depth rather than a
thing a test pins on its own. The dry-run branch is NOT defence in depth: a
dry run leaves the hook on disk, so it must predict removal from the plan
instead of reading `existsSync`, and tests/init.test.ts:2212 goes red if
that branch reads the world. The init suite is 136 tests.

No manifest shape with an adoption and no hook entry is reachable from
init's own writes, which is what makes the removal safe. Init sets
`adopted` in exactly two ways (src/init.ts:1305-1312): the run that adopts,
which pushes the hook it writes into the same manifest, and the carry
across a re-init, which keeps a previous manifest's entries that this run
did not rewrite. Revert's own rewrite (src/init.ts:1679) can only drop
the hook entry on a pass that also nulls `adopted`. A hand-edited
manifest could hold that shape, and there the code does what the old flag
did: nothing is restored.

No manifest at all means nothing is removed and the command fails
(src/init.ts:1461-1471). Pinned by tests/init.test.ts:920.

A manifest that will not parse is a SECOND conflict rather than the same
one (src/init.ts:1479-1494). Revert deliberately does not go through
`readManifest`, which answers null for both: missing means there is no
record to act on, unreadable means there is a record and it cannot be
trusted, and the two send a reader to different fixes. Nothing is removed
and nothing is guessed either way. Pinned by tests/init.test.ts:926,
which corrupts the manifest of a real install and asserts the reason is
`manifest-unreadable`, that the guidance says nothing was removed and
sends the user to the file by hand, and that the hook, the policy file and
the manifest itself are all still exactly as they were.

End to end by tests/dogfood.e2e.test.ts:417 and 435, which revert a real
repository with a hand-edited policy file and then finish the job under
`--force`. The ordinary case, that revert removes what init wrote and
leaves an unrelated file alone, is tests/init.test.ts:667, and the second
`--force` revert that cleans up after a refused one is
tests/init.test.ts:809.

## The manifest is untrusted input: every path it names is contained to the repository

`.guardrails/manifest.json` is committed to the repository, so a person
who can land a commit can put any path in it. It is untrusted input, and
both revert and apply treat it that way: every `files[].path` and the
`adopted.path` is contained to the repository before anything is written
or deleted. A path is refused if it resolves outside the repository, AND
refused if any component of it is a symlink. Without this, a crafted
manifest made revert delete a file anywhere on disk through a `files[]`
entry, or write an executable one anywhere through `adopted.path` on the
umbrella-hook-gone restore, and exit 0. Every case was reproduced against
the built CLI, and the symlink case end to end through a real `git clone`.

Containment (`manifestPathInsideRepo`, src/init.ts:692-753) has two
conditions, because a path escapes two ways. Its string form, resolved
against the repository root, must be inside it: this refuses an absolute
path and one that climbs out with `../`, the same reasoning as
`resolvesInsideRoot` (src/intent-spec.ts:267-280). And no component of the
path may be a SYMLINK. The paths here need not exist yet, because an
adopted hook is restored to a path revert has just removed and a recorded
file may be legitimately gone, so an earlier version resolved only the
deepest EXISTING ancestor with `existsSync` and treated the rest as a plain
leaf. That was bypassable: `existsSync` FOLLOWS a symlink, so a committed
DANGLING symlink (its target absent) read as not there, the leaf was judged
a plain not-yet-existing path inside the root, and `writeFileSync` and
`chmodSync`, which DO follow the final link, landed the write on the outside
target. The components are now scanned with `lstatSync`, which does not
follow, so a symlink is caught even when its target is gone; init never
writes through a symlink, so any symlink component means the path is not one
init wrote. The scan still stops at the first component that does not exist,
because nothing below a missing component exists, which keeps a legitimately
gone in-repo path revertible.

Revert checks every recorded path up front and refuses the whole
operation, rather than skipping one path at a time, with a new conflict
`manifest-path-outside-repository` whose guidance names the offending path
(src/init.ts:1505-1522). Apply contains every path it writes the same way,
including the `adopted` record carried forward from the committed manifest
(src/init.ts:1320-1338). The conflict reason is at src/init.ts:563-569.

Pinned by tests/init.test.ts:2075 (an absolute `files[]` path outside the
repository is refused and the file it aimed at is untouched), 2100 (a
`../` path that climbs out is refused and nothing is removed), 2119 (an
escaping `adopted.path` is refused and no file is written where it
pointed), and 2158 (apply refuses a write path outside the repository and
writes nothing). The symlink class is pinned by tests/init.test.ts:2278 (a
committed dangling relative symlink as `adopted.path`), 2301 (its symlink
pointing at an absolute outside target), 2320 (a dangling symlink component
mid-path), and 2341 (a `files[]` path that is a dangling symlink, on the
delete side); each asserts nothing is created outside. The regression that
an ordinary in-repo manifest still reverts is tests/init.test.ts:2147 and,
with no symlink anywhere, 2360. Removing the string check turns the
non-symlink escape tests red, and reverting the component scan to the
`existsSync` ancestor walk turns the symlink tests red.

## Revert honours --dry-run: it plans and prints, and touches nothing

`--dry-run` promises to write nothing, and `--revert` promises to remove
what init wrote. Together they must plan the revert and change nothing, but
the CLI routed `--revert` to `revertInit` before `--dry-run` was consulted
and `revertInit` had no dry-run branch, so `init --revert --dry-run`
performed a real destructive revert.

`revertInit` now takes `dryRun` and skips every write while running every
read and every decision, so what it reports is exactly what a real revert
from the same state would do (src/init.ts:1444-1449, the flag; the guarded
writes are the file removals at src/init.ts:1578-1580, the adopted-hook
restore at 1618-1622, the manifest removal at 1632-1634 and its rewrite at
1678-1684). `ok` is unchanged by the flag, so `--revert --dry-run` exits
the way the revert it previews would: the CLI threads the flag through
(src/cli.ts:277-282) and maps `ok` to the exit code as always.

One prediction cannot be read off the disk. Whether an adopted hook would
be restored turns on whether the umbrella hook would be gone after the
pass, which a real revert reads with `existsSync` after removing it. A dry
run did not remove it, so the dry-run branch asks the plan instead: a
recorded hook that reached this point is already gone, was matched (so it
would be removed), or is changed under `--force`, and any changed hook with
no `--force` returned far above (src/init.ts:1602-1614). Without this a dry
run of an adopted revert would mispredict `ok`.

The directory line is decided read-only on a dry run, since it cannot
rmdir to learn whether `.guardrails` would be left empty
(src/init.ts:1637-1652). `renderRevertHuman` says "(dry run)" and turns
every action verb into "would ..." (src/init.ts:1731-1744).

Pinned by tests/init.test.ts:2189 (an installed hook, policy and manifest
are byte for byte identical after a dry-run revert, and it still reports
success so the CLI exits 0), 2212 (a dry-run revert of an adopted setup
restores nothing on disk and still predicts success), and 2230, which
drives the real built CLI with `init --revert --dry-run` and asserts exit 0
with every file unchanged. Forcing `dryRun` to false turns all three red.

## Intent at pull request time: nothing is ever written under the repository's own state directory

The intent gate refuses to check anything against a contract nobody
approved, and approving one is a per-task human step. That step is the
ceremony the stopping-points design exists to keep out of a pull request,
so the umbrella imports the document the work was actually approved from,
freezes it in a TEMPORARY directory, and points the gate at that directory
for the length of one run (src/intent-prepare.ts:626-642).

Nothing is written under the repository's own state directory, under
either of its two names. A contract is a committed artifact with an
approver's name on it. A pull-request run that dropped one into the
working tree would either be committed by accident or picked up by the
next run as though a person had approved it, and the second failure is
silent. Pinned by tests/intent-prepare.test.ts:306, which asserts the
repository has no `.conductor` AND no `.intent-guard` directory
afterwards. Both names, because checking only the one the draft is written
under would pass for a version that migrated the temporary project and
then wrote into the repository under the new name.

THE DRAFT IS WRITTEN UNDER THE LEGACY NAME inside that temporary
directory (src/intent-prepare.ts:632-642), and that is a version
independence decision rather than an oversight. A 1.2.x intent-guard reads
only `.conductor/`; a 1.3.0 one reads it as the legacy fallback and
renames it to the canonical name on its first write, which the freeze is.
Writing the canonical name would work on 1.3.0 and leave 1.2.x freezing an
empty project. Pinned by tests/intent-prepare.test.ts:813.

FREEZE EXITING 0 IS NOT PROOF THERE IS A CONTRACT TO HAND THE GATE. After
the freeze the contract is looked for under both names, canonical first,
and its absence is a named preparation failure at the freeze step rather
than a confusing verdict from the gate three steps later
(`frozenContractIn`, src/intent-prepare.ts:350-354, called at
src/intent-prepare.ts:695). That lookup asks EXISTS rather than FROZEN,
unlike the repository-side one, because reading `frozen_by` here would be
the umbrella second-guessing a decision it has just asked intent-guard to
make. Pinned by tests/intent-prepare.test.ts:825, whose stub freezes
successfully and removes both directories.

The freeze is attributed to the umbrella and to a commit, never to a
person, and the spec path in that attribution is repository-relative
because the string ends up inside a contract (src/intent-prepare.ts:664-669).
Pinned by tests/intent-prepare.test.ts:335.

The temporary directory is always removed. Every failure path after the
directory exists calls `cleanup` before returning
(src/intent-prepare.ts:630-686), and the success path is removed by the
caller's `finally` once every gate has run, whatever happened while they
did (src/run.ts:485-494). The failure half is pinned by
tests/intent-prepare.test.ts:440, which drives the chain to a freeze that
refuses and then finds no directory carrying `TEMP_PREFIX`.

THE SUCCESS HALF IS PINNED AT tests/intent-run.test.ts:171, which drives a
full passing run through the import and freeze chain and looks in the same
place, the same way. It asserts the run really did import a contract
before it looks, so it cannot pass on a directory that was never created.
Nothing in the code changed for it: removing the `cleanup()` call from the
`finally` in src/run.ts turns that one test red and leaves every other
test in the file green, which is what makes it the thing holding the rule.

BOTH LOOK IN A ROOT OF THEIR OWN rather than in the system temporary
directory, and that is not cosmetic. They live in two files, jest runs
those in separate workers, and each was counting the other's directories:
the count could move in either direction between the two reads for reasons
that had nothing to do with a leak. The root is injected
(`IntentPrepareOptions.tempRoot`, threaded through `RunOptions.tempRoot`),
the same seam the environment and the clock already use, and nothing in
production passes it. TMPDIR would have been the smaller change and does
not work: node reads it from the real process environment, and a jest
test's `process.env` is a copy that never reaches it.

The cost of being wrong is one leaked directory per pull request on a
shared CI runner, with nothing in any report pointing at the cause. Note
that tests/intent-prepare.test.ts:355 does NOT cover this: it only proves
that calling `cleanup` yourself works.

## The repository's own frozen contract wins, and "frozen" means one specific thing

Where a team has done the native flow, the native flow is what runs. The
import is the fallback for a repository that has not, never a replacement
for one that has (src/intent-prepare.ts:486-509).

"Exists" is not the test. `frozen_by: user` and nothing else, because that
is the marker THE GATE ITSELF reads
(`contractIsFrozenAt`, src/intent-prepare.ts:191-214). BOTH halves of the
gate's own test, `frozen_by: "user"` AND an `approval` record present,
because that is what `isContractFrozen` does and its comment says
`frozen_by` alone, hand-set in YAML, is not enough; accepting half of it
calls a contract frozen that the gate will call unfrozen, which skips the
import and then blocks the pull request on "not frozen by user" without
checking anything. A real freeze on either version writes both, so
requiring both excludes no contract either tool produced. Pinned by
tests/intent-prepare.test.ts:841. Accepting an
`approval` block as an alternative was a guess dressed up as tolerance: a
real freeze writes both, so the only contracts the second test admitted
were hand-edited or half-written ones, and admitting those skipped the
import and then let the gate block every pull request with "exists but is
not frozen by user". A file that will not parse is treated as not frozen,
which sends the run down the import path rather than handing the gate
something it will reject.

THE CONTRACT LIVES UNDER ONE OF TWO NAMES, CANONICAL FIRST. intent-guard
1.3.0 renamed its per-project state directory from `.conductor` to
`.intent-guard`, because `.conductor` had become the name of a different
product in this same family, and a repository adopting both showed
`.conductor/` and `.guardrails/` side by side with nothing to say which
tool owned which. Both are read, so a repository on either version is
checked rather than blocked; the pair and its order are declared once
(`NATIVE_CONTRACT_PATHS`, src/intent-prepare.ts:84-87) and every consumer
reads that rather than spelling the order itself. The filter that applies
it is `frozenNativeContracts` (src/intent-prepare.ts:231-235).

THE ORDER IS A DECLARATION WITH NO OBSERVABLE EFFECT TODAY, and saying
otherwise would be exactly the kind of claim this file exists to catch.
tests/intent-prepare.test.ts:596 pins the declaration and nothing else
can, because no consumer currently distinguishes the two entries: the
conflict rule below refuses every repository that could hold both, so
`frozenNativeContracts` never returns more than one and only `[0]` is ever
read, and `frozenContractIn` is compared to `null` and its value discarded.
Reversing the pair turns exactly one assertion red and changes no
behaviour. The order becomes load-bearing the day something reads WHICH of
the two answered; until then this is a convention, not an invariant.

A REPOSITORY WITH BOTH STATE DIRECTORIES IS COULD-NOT-RUN
(`stateDirsConflict`, src/intent-prepare.ts:334-339, over the marker list
at src/intent-prepare.ts:264-270 and `holdsIntentGuardState` at 304-309,
raised at src/intent-prepare.ts:471-483 as a `contract-source` step of its
own).

THIS MIRRORS THE GATE'S OWN CONFLICT RULE EXACTLY, and the exactness is
the point: the canonical directory merely EXISTING, even empty, beside a
legacy directory holding any of intent-guard's own state markers
(`config.yaml`, `intent-contract.yaml`, `index.md`, `drift-log.jsonl`,
`contracts`), frozen or not. A `.conductor` holding none of them belongs
to something else and is left alone, which is the one case where the two
coexist legitimately.

THE TWO SIDES TEST DIRECTORY-NESS DIFFERENTLY, and the asymmetry is the
gate's own rather than an oversight. The legacy side uses `lstat`
(`isRealDirectory`, src/intent-prepare.ts:296-302), so
`ln -s .intent-guard .conductor` -- the obvious workaround for a script
that still names the old path -- is not a legacy state directory at all;
following it would make ONE directory look like two and fail the run closed
on a conflict that does not exist. The canonical side keeps `stat`
(src/intent-prepare.ts:272-278), because a canonical directory reached
through a symlink is still one intent-guard reads and writes. Making both
sides `lstat` would look neater and would miss that conflict. Both halves
are pinned: tests/intent-prepare.test.ts:696 (the legacy symlink is not a
conflict) and 715 (the canonical symlink still is).

An earlier version of this rule was NARROWER -- both directories holding a
FROZEN contract -- and this file argued for it: a stale unfrozen draft
beside a real contract has an obvious right answer, and refusing would
fail pull requests over a file nobody had looked at in months. That
argument was about the wrong tool, and an independent review found it
against the real 1.3.0 build. In that exact state the gate's `stateDir`
throws and every intent-guard command exits 1, so the narrower rule saved
none of those pull requests; it moved where they broke. conductor handed
the gate a repository the gate refuses to run in, the child exited
non-zero with no JSON, and the run surfaced as
`conductor/gate-output-unparseable` with a message about the umbrella
being out of date with the gate. The lesson is the one at the top of this
file: a claim about another tool is worth exactly as much as the run that
checked it, and this one had not been checked.

The check sits ABOVE the `--spec` branch, because the import path runs
`import-spec --project .` in that same repository, where the gate fails
closed on the same conflict and reports it as an opaque non-zero exit from
a subcommand. The guidance says to MOVE the old directory aside and never
to delete it: conductor has not read what else is in there.

Pinned by tests/intent-prepare.test.ts:640 (both frozen, the case a reader
thinks of first, now subsumed), 656 (an unfrozen draft beside a real
contract, which is the case the narrow rule got wrong), 675 (a
parameterised case over all five of the gate's own state markers), 734 (a
`.conductor` holding none of them is somebody else's and is ignored), 751
(the message names both directories and says move rather than delete) and
796 (the flag does not get past it).

READING THE OLD DIRECTORY IS SAID OUT LOUD, as one aside on the text
report's contract line (src/output-text.ts:113-120) and one
`intent-guard/legacy-state-dir` notification in the SARIF log
(src/output-sarif.ts:564-588). Both go through one predicate over the
source path (`isLegacyContractPath`, src/intent-prepare.ts:97-99) rather
than a boolean carried beside it: the path is already the fact, and a flag
travelling next to it is a second copy that can disagree with the first.
It is a NOTIFICATION rather than a result, and it is the closest call of
the five: nothing went wrong, the gate ran, and the verdict is exactly
what it will be after the migration, so as a result it would be a
fingerprint-less alert reappearing on every pull request until somebody
upgrades. Pinned by tests/intent-run.test.ts:606 (in the log as a
notification, naming both paths), 632 (never a result, in the other
direction), 646 (the text report) and 658 (silent on the canonical
directory, in both formats).

An explicit `--spec` outranks even a frozen native contract
(src/intent-prepare.ts:487-490, where the `flag` branch is taken before
the native contract is consulted), because a person typed it just now.

The native-contract rule is pinned by tests/intent-prepare.test.ts:153,
163, 169, 179 and 197, and by 607 and 621 for the two directories. THE
`--spec` PRECEDENCE IS PINNED BY
tests/intent-prepare.test.ts:230 and 241, which build one repository
holding both a `frozen_by: user` native contract and a spec, pass the
spec by flag, and assert the reported source is the imported spec and
that the gate is handed a temporary directory rather than `.`, with
`import-spec` and `freeze` both recorded as having run. Note that the
native tests above have a DISCOVERED spec beside the contract, which is
the opposite rule; and tests/intent-spec.test.ts:246 covers `--spec`
beating a pull request body, a different question in a different file.
Neither covers this.

The branch order at src/intent-prepare.ts:487-490 is still the mechanism.
Before those two tests, a reordering that tested `nativeContractIsFrozen`
first would have looked correct in review, because every existing test
passed either way: none of them had both. What a user would have seen is
`--spec` ignored in exactly the repositories that have done the native
flow, with the report naming the native contract as the source, so the run
would be honest about what it used and silent about what it was asked
for. Swapping the two branches now turns both tests red.

## Spec discovery: three sources, and the order is the whole decision

`--spec` on the command line outranks everything. A path there that does
not exist is REPORTED rather than replaced by a discovered one, because
running a different contract than the one a person just named is the wrong
kindness (src/intent-spec.ts:284-290, reported at
src/intent-prepare.ts:454-462).

A `Spec:` line in the pull request body comes next, anchored to the start
of a line so a sentence containing the words in prose is not read as
somebody naming a file, and the FIRST such line wins when a body carries
two (src/intent-spec.ts:118-121). A path here that does not exist falls
through to the convention, because a typo in a pull request description
must not be able to fail a build.

`Spec: none` in that same first line is the one value that does NOT fall
through. It is a WAIVER: a statement that this pull request deliberately
has no spec, answered with a `waived` discovery before the convention is
tried, because an explicit statement beats an inferred one
(src/intent-spec.ts:294-302, with the token itself at
src/intent-spec.ts:51-59). The token is exact and lowercase; anything else
unusable keeps the silent fall-through, so a sentence with "None" in it
cannot switch a gate off. The waiver sits BELOW `--spec` in this file and
below a frozen native contract in prepareIntent
(src/intent-prepare.ts:491-504, the branch after the native contract
rather than before it), which is the whole meaning of it: it says there is
nothing to import, never that a contract this repository froze should be
ignored.

The convention is a markdown file DIRECTLY under `docs/superpowers/specs`
whose stem relates to the branch slug. Directly under, not nested, because
that is the layout the gate's own importer discovers and an archive
subdirectory is not a candidate for this branch's contract
(src/intent-spec.ts:146-156).

Candidacy and victory are different questions. `stemMatches` decides who
is a candidate; `bestMatch` decides who wins, ranking an exact stem first,
then the most specific stem by length, and only then the newest filename
(src/intent-spec.ts:184-203). Ranking on the newest name alone answered
the second question with the first: a loose candidate carrying a later
date beat the spec whose stem was the branch slug exactly, and an undated
name beat everything because it sorts after every date. A pull request was
then measured against a different feature's requirements with nothing in
the report saying so.

A plan is paired only on an EQUAL stem (src/intent-spec.ts:219-226). No
plan is a fine outcome, since the gate imports a spec on its own; the
wrong plan freezes one feature's requirements against another's change
budget, and the resulting block or pass is about neither of them.

Pinned by tests/intent-spec.test.ts:137 and 149 (the convention, and the
plan paired by the same stem rule), 161, 175 and 193 (the ranking: the
newest name only among equally good candidates, an exact stem beating a
newer looser one, and an undated name not winning by sorting last), 206
and 216 (the most specific match, and no plan rather than another
feature's), 230 and 246 (a `Spec:` line beating the convention, and
`--spec` beating the `Spec:` line), 263 (a `Spec:` path that is not there
falls through), 401 (a `--spec` path that is not there is reported
instead), and 419, 425, 431 and 440 (nothing matches, no directory, a
nested spec, a non-markdown file), with 446 for a plan paired to a spec
that came from the pull request body.

The waiver is pinned by tests/intent-spec.test.ts:460 (it beats the
convention with a matching spec sitting on disk), 475 (it answers `waived`
rather than `none`, which is what lets the report tell the two apart), 483
(`--spec` still wins), 500 (`Spec: None` with a capital falls through to
the convention instead), and 518 (the first `Spec:` line decides, so a
later real path does not undo it).

## Containment applies to the pull request body and to nothing else

A path named in a pull request body must RESOLVE inside the repository
(`resolvesInsideRoot`, src/intent-spec.ts:267-280). That body is written
by whoever opened the pull request, and on a fork pull request that is
somebody with no write access at all. Without the check, a
`Spec: ../../etc/something` line imports an arbitrary readable file from
the runner into a contract, and its path then appears in the reported
`contractSource` and inside the `--approved-by` string.

The test is on the RESOLVED path, not on the spelling. A string test left
a two-step route to the same escape, and one pull request can take both
steps: on a `pull_request` event the checkout is of the merge ref, so a
fork's own commits are in the tree, and the same pull request can add a
symlink pointing outside AND the `Spec:` line naming it. To a string test
that line is an ordinary relative path.

This is containment, not a ban on symlinks: one pointing at a file inside
the repository resolves inside it and is used. A path that will not
resolve at all is not contained either, which lands it in the same place
as a path that is simply not there. The repository root is itself resolved
before the comparison, because on macOS a temporary directory reaches the
caller through a symlink and comparing a resolved candidate against an
unresolved root would report every path in such a tree as an escape.

`--spec` is deliberately NOT held to any of this. A person typed it on the
command line just now, and pointing at a spec kept outside the checkout is
a real thing to want (src/intent-spec.ts:284-290 goes straight to
`exists`).

Pinned by tests/intent-spec.test.ts:295, 312, 324, 332, 354, 375 and 392.

## A branch with no spec is advisory, and never changes the exit code

A `SkippedGate` is not a deferred gate, not a could-not-run, and not a
finding (src/run.ts:72-77 and 435-443). Nobody asked for a different
stage, nothing broke, and a branch that has no spec is a branch this gate
has no opinion about. Turning that into a failed build is how a gate gets
switched off repository-wide.

It never reaches the exit code, enforced or not, because a skipped gate
produces no `GateOutcome` and `composeExitCode` only ever sees outcomes.
It is still on screen: one line in the text report
(src/output-text.ts:231-236), one notification in the SARIF log
(src/output-sarif.ts:650-663), and a distinct verdict sentence when it is
the only thing that happened (src/output-text.ts:455-466), because telling
somebody to set `enabled: true` is the wrong advice for a gate that is
already on and had nothing to check.

The contract source is decided BEFORE git is touched
(src/intent-prepare.ts:438-452). That ordering is the promise: resolving
the base ref first would turn a shallow checkout into exit 2 on a
repository the gate was never going to check anything in.

There are TWO reasons a gate lands here, and they are carried apart rather
than flattened into one sentence: `no-contract`, the ordinary state of a
branch nobody has written a spec for, and `contract-waived`, a pull request
body that said `Spec: none`. The reason travels from prepareIntent through
`SkippedGate` into both reports. In the SARIF log it IS the second half of
the notification id, so `intent-guard/no-contract` stays exactly where
consumers already have it and the waiver gets an id of its own. In the text
report it decides the wording in ALL THREE places that report a skip, and
one function answers for all three (`skipWording`,
src/output-text.ts:253-274): the skipped line, the verdict sentence for a
run whose gate list is empty, and the clause on the one-line summary of a
clean run.

Three, not one, and this was wrong when it was first written. Only the
skipped line was reason-aware; the verdict still said "had no contract to
check against" and the summary still said "Nothing to check against". Both
of those tell a reader to go and write a spec, on a pull request whose
author has just written down that there is none, and the two that were
wrong are the ones people actually read: the verdict is the last line of
the report, and the summary line is the WHOLE report on a clean run, which
is what a pre-commit hook and the pull request comment step in the README
print. The paragraph above claimed the reason reached "both reports"
before it did.

Pinned by tests/intent-run.test.ts:267, 281, 285, 289 and 316, and
tests/intent-prepare.test.ts:369 and 378 ("never runs git, so a shallow
checkout cannot turn a missing spec into a failure"). The waiver half is
pinned at tests/intent-prepare.test.ts:544 and 557 (the reason is the
waiver, and a frozen native contract still outranks it) and
tests/intent-run.test.ts:475, 489 and 517 (the reason reaching the run
result, the SARIF notification under its own id, and the skipped line plus
the summary clause, which asserts the summary does NOT say "Nothing to
check against"). The verdict is pinned separately at
tests/intent-run.test.ts:571, with an INTENT-ONLY policy, because that is
the only shape that reaches it: the policy declared at line 452 puts a
second, clean gate beside the waived one, so its run has a `GateOutcome` and never takes the
empty-gates branch. An intent-only policy is not a corner case, it is what
`--gate intent` produces.

## The change set is the umbrella's own, and each flag is a decision

The umbrella computes what the branch changed rather than handing the gate
its own `--base`, because `--base` inside the gate resolves git relative
to `--project`, which may be a temporary directory with no repository in
it (`changedPathsSince`, src/intent-base.ts:76-107).

Three flags, each one a decision. `-c core.quotePath=false`, or git
escapes any byte outside ASCII and wraps the line in quotes, handing the
gate a path that matches no glob and no file on disk. `--no-renames`, so a
rename lists BOTH its old and its new path, since moving a file out of a
protected directory still has to block and cannot if only the destination
is listed. And the three-dot range, which asks what the branch changed
since it forked rather than how it differs from the base branch right now.
A two-dot diff attributes every commit that landed on the base branch
after this branch forked to this branch, so somebody else's merge breaches
this pull request's change budget.

Output is split on newlines and NOTHING else (src/intent-base.ts:131).
Trimming each line was corrupting a filename with leading or trailing
whitespace into a different filename, which is worse than refusing it: the
gate would then check a path that does not exist and never check the one
that changed.

A prepared run replaces `--staged` entirely rather than adding to it
(src/gate-runner.ts:463-485), because the two path sources are ADDITIVE in
the gate, so leaving `--staged` on would silently widen a pull request's
change set with whatever happens to be in the index of the machine running
it. `--paths` is passed even when the branch changed nothing, so the empty
set is stated rather than left for the gate to fill in from the index.

`GITHUB_BASE_REF` is a branch name and not a ref anything local can
resolve, so it is prefixed with `origin/`; Actions defines it and leaves
it EMPTY outside a pull request, so an empty value has to mean "no pull
request" rather than "origin/", which would fail every push build closed
(src/intent-base.ts:38-50). The branch name comes from `GITHUB_HEAD_REF`
first, because a pull request build is on a detached head and git answers
"HEAD" there, matching no spec at all (src/intent-base.ts:60-74).

The environment is INJECTED into `runAll` and defaults to EMPTY rather
than to `process.env` (src/run.ts:184-193 for why, src/run.ts:388 for the
default itself). Without that, running this package's own suite inside a
pull request build would put every gate into the pull-request flow,
because Actions sets `GITHUB_BASE_REF` for the whole job.

Pinned by tests/intent-base.test.ts:57, 64, 71, 78 and 82 (the base ref,
including the empty `GITHUB_BASE_REF` a push build sets), 91 (the
three-dot range: what landed on the base afterwards is not listed), 110
(both sides of a rename), and 121 and 135 (the quotePath decision, and
that an ordinary space survives it); and
tests/intent-run.test.ts:198 (the branch diff rather than the index), 227
(the base taken from the pull request environment), 420 ("is never read
unless the caller passes it in") and 538.

## Reporting: a statement about coverage is a notification, a statement that something went wrong is a result

This is the discriminator, and it is written here because it has now been
taken four times and should decide the fifth case itself.

A statement about HOW MUCH OF THE POLICY A RUN COVERED is a NOTIFICATION.
It is true of the configuration rather than of this change, identical on
every run until somebody edits the policy file, and on the adoption ramp
deliberately true for weeks. A permanent alert is a dismissed alert, and
it teaches the reader to dismiss the next one. Five cases live here:
`conductor/gate-deferred` (src/output-sarif.ts:536-544),
`conductor/gate-excluded` (src/output-sarif.ts:600-608), the per-product
skipped advisory, whose id is the product and the skip reason and so is
either `no-contract` or `contract-waived` (src/output-sarif.ts:650-663),
`conductor/gate-not-enforced` (src/output-sarif.ts:873-906), and
`intent-guard/legacy-state-dir` (src/output-sarif.ts:564-588), all of them
collected at src/output-sarif.ts:960-971 and written into
`invocations[0].toolExecutionNotifications` on the umbrella's run
(src/output-sarif.ts:470-483 and 985-1018). As results they were
fingerprint-less note alerts that reappeared on every run, so a repository
on the adoption ramp accrued permanent alerts about this tool's own
configuration.

A statement that SOMETHING WENT WRONG is a RESULT. It is about this run,
it goes away when somebody fixes it, and a reviewer of this change is the
person who should see it. `conductor/gate-missing`,
`conductor/gate-failed` and `conductor/gate-output-unparseable` stay
results, because a gate that could not run means a class of problem went
unlooked-for on this change. So do the umbrella's own normalization
diagnostics (src/output-sarif.ts:499-519), because a disagreement between
the umbrella's report and the gate's own verdict is a defect in this run
rather than a property of anybody's configuration.

The text report answers the same question the same way, and the two must
keep agreeing. `isFullyClean` (src/output-text.ts:570-581) forces the full
report when the umbrella has a diagnostic and does NOT force it for a
gate's own note, for exactly this reason: the standing note that pnpm
lockfiles do not record install-script metadata is a permanent property of
that file format, true on every run forever.

The notification descriptor id keeps the id the statement was filed under
when it was a result, so a consumer that had rules for these still
recognises them, and the descriptors are declared beside the rules so the
reference resolves rather than dangling (src/output-sarif.ts:404-414,
declared at 416-421 and attached at 464-466). Level is always `note`; a
notification arriving as a warning would push these straight back into
the alert list they were moved out of.

Pinned by tests/output-sarif.test.ts:142 (gate-deferred moved out of
results and into the notifications), 149 (gate-excluded, the same way),
171 (nothing said about exclusion when there was no `--gate`), 180
(gate-not-enforced), 189 (the no-contract advisory, keeping the GATE'S
own namespace on its descriptor id), 196 (that advisory at note level),
210 (the message text unchanged in the move), 217 and 254 (gate-missing
and gate-failed staying results, in both directions), 285 (the
notification objects are shaped as SARIF 2.1.0 wants, every level is
`note`, and the descriptor ids are declared on the driver), 957 (a
normalization diagnostic as a note-level result carrying blocking: false
and, since 0.3.0, the policy file as its location rather than none at all)
and 996 (naming the gate it came from). The remaining
result id, `conductor/gate-output-unparseable`, is pinned end to end by
tests/cli.test.ts:162, which runs the CLI over a gate whose output has
drifted and finds that id among the umbrella run's RESULTS.

In the text report, pinned by tests/output-text.test.ts:371 and 379 (an
umbrella diagnostic forces the full report and is not counted as a note)
and 295, which is the other half and was uncited here: two of a gate's
OWN notes leave the run clean, are counted rather than printed, and do
not force the full report.

A naming disagreement used to live here, and the shape of it is worth
keeping even though it is gone. Two source comments and the README all
named this diagnostic `conductor/blocking-mismatch`, and nothing had ever
emitted that string; the codes the code emits are
`conductor/blocking-count-mismatch` and
`conductor/blocking-threshold-unknown` (src/normalize.ts:26-27). Worse,
two tests built fixtures using the phantom name and then looked for what
they had just constructed, so the phantom had a green test beside it.
The phantom is now gone from the code, the README and the fixtures, and
BOTH codes are pinned at the normalizer, which is the only place either
is minted: tests/normalize.test.ts:49 drives the count-mismatch branch by
tampering with the gate's reported count, and tests/normalize.test.ts:62
drives the `threshold === null` branch (src/normalize.ts:110-121) by
deleting `run.failOn`, asserting the emitted code and that nothing is
left marked blocking.

## The clean-run summary line, and what it may not swallow

A fully clean run prints one line rather than a screenful
(`summaryLine`, src/output-text.ts:604-726, reached at
src/output-text.ts:731-733, and NOT reached when the trust base was refused,
which is the one thing that outranks a clean run). Twelve lines of per-gate
detail on a commit
that found nothing is a cost paid on every commit, and it is what makes a
team switch a hook off.

The predicate is not simply the exit code (`isFullyClean`,
src/output-text.ts:570-581). Three extra conditions, and each one exists
because collapsing it would swallow the only report anybody sees. A gate
with `enforce: false` is left out of the composed code, so a run where
such a gate blocked or could not run still exits 0. An umbrella
diagnostic forces the full report. And a run where no gate ran at all is
not clean whatever the exit code says: "none is enabled", "every gate was
deferred" and "nothing had a contract to check" are three distinct states
with three distinct verdict sentences, and a summary line naming no gates
would be the exact confusion this family exists to prevent.

Pinned by tests/output-text.test.ts:252, 263 and 270 (one line, none of
the per-gate detail, and how to see the rest), 274 (`--verbose` prints
the full report anyway), 391 (an unenforced gate that blocked forces the
full report even though the run exits 0), 403 (so does one that could not
run), 371 (so does an umbrella diagnostic) and 424 (a run where no gate
ran at all). The half that must NOT force it, a gate's own note, is
pinned at tests/output-text.test.ts:295.

What the one line still has to carry: which gates ran, which were deferred
to a later stage, which had nothing to check, which the command line left
out, which could not have blocked because they are unenforced, a count of
non-blocking findings, a count of the gates' own notes, and how to see the
rest. Pinned by tests/output-text.test.ts:257, 280, 295, 327, 347 and 747.

Three of those are suppression, and print as a count EVEN AT ZERO
(src/output-text.ts:644-649 for gates the command line left out, 664-672
for gates that are not enforced, 699-708 for the suppressed and ignored
totals summed across gates). This is the family rule dep-guard's stability
policy states: a gate that can be turned off, dropped by `--gate`, or a
finding count baselined away is the user's decision, and a clean line that
said nothing about it would let a repository whose gate had no vote read as
fully gated. The suppressed total always prints because it is always a
number the gate reported; the ignored total prints only when every gate
that ran reported one, because a gate that drops ignored files before its
own output has no count, and "0 ignored" there would state a fact no gate
stated. SARIF is unchanged: these stay coverage clauses on the text line
and the notification-versus-result rule below is untouched. Pinned by
tests/output-text.test.ts:814 and 827 (the not-enforced and excluded
counts print at zero), 818 and 831 (they count and name when there is
something to name), 837 and 841 (the suppressed and ignored totals, at zero
and summed), and 854 (the ignored total is dropped when a gate did not
report one). Zeroing any of the three counts turns its tests red.

`--verbose` is a command-line flag rather than a policy key
(`TextOptions`, src/output-text.ts:530-539), because the schema describes
what a repository gates on and how loud one developer's terminal is is
not that.

SARIF IS UNAFFECTED BY IT. `renderSarif` takes no verbosity argument at
all (src/output-sarif.ts:915), and the format branch in the CLI passes the
flag only to `renderText` (src/cli.ts:386-389). Pinned by
tests/cli.test.ts:275, 287 and 295, and by
tests/output-sarif.test.ts:526, which asserts the log is byte for byte
what it was before the summary line existed, against a literal written
out by hand rather than against whatever the renderer currently produces.

## SARIF says only what it can support

One run per gate, in gate order. SARIF puts the tool name and version on
the run, so a single run cannot honestly describe three tools
(src/output-sarif.ts:918-944).

A gate that never ran gets NO run. The tempting alternative is an empty
run named for the missing product, which puts that tool's name on
something it never did. The umbrella's own findings about it go into a
final run whose driver is the umbrella, the only honest owner of a
statement about a tool that is not installed
(src/output-sarif.ts:918-924 for the skip and 953-1018 for the run).

THE SAME RULE CURRENTLY CATCHES A GATE THAT RAN AND FAILED, and those are
two different things. A gate that exited 2 did run; the SARIF-native shape
for it is its own run with `invocations[0].executionSuccessful: false`,
and that is deliberately NOT done, because it changes the run list of
every log with a failing gate in it. The consequence is load-bearing
rather than cosmetic: `conductor/gate-failed` in the umbrella's run is
then the only place in the whole log that can say anything about the
failure, which is why that finding carries the failing child's own stderr
(`normalizeFailedGate`, src/normalize.ts:885-900, fed from
src/gate-runner.ts:839). Before it did, a dogfood run against a
repository with an unparseable lockfile printed dep-guard naming the file
and the reason in the text report, and put "the gate exited 2, which it
uses for could not run" and nothing else in both `message.text` and
`properties.details.detail` of the log beside it. The stderr is trimmed,
capped at 2000 characters and truncated out loud rather than silently
(`summariseStderr`, src/normalize.ts:841 and 851-863), and a gate that
failed silently keeps the
message it had. The fingerprint is unaffected, because it is computed over
the rule, the role and the product and never over the message.

`conductor/gate-output-unparseable` CARRIES IT TOO, for the same reason
and through the same helper (`normalizeUnparseableGate`,
src/normalize.ts:809-830, fed from src/gate-runner.ts:860, 900 and the
backstop at 564). That
result had the identical gap and one very live case: a gate refusing to
run at all exits 1 with no JSON and says why on stderr, which is exactly
what a state-directory conflict looks like from the umbrella's side.

`summariseStderr` is also what the intent gate's PREPARE-step failures
report with (`complaint`, src/intent-prepare.ts:420-422). That one
replaced a first-line
guess, and the replacement was a bug fix rather than a tidy-up: the
prepared project is written under the legacy directory name, so
intent-guard 1.3.0 prints its rename notice as line one of stderr on every
import-spec and every freeze there. Reporting line one therefore named the
rename notice as the reason the step failed and discarded the sentence
saying what was actually wrong, on every failure, on the version this
release exists to support.

Pinned by tests/run.test.ts:418, 428, 442, 452 (the unparseable carry) and
472, by tests/output-sarif.test.ts:1306, 1314, 1322 and 1333, and by
tests/intent-prepare.test.ts:859 (the real error survives a notice line
ahead of it) and 879 (that stderr is capped too).

No invented version. A gate whose version could not be read gets no
`version` field rather than a placeholder (src/output-sarif.ts:456-460).

`%SRCROOT%` is attached only to a path genuinely under the source root
(`placeArtifact`, src/output-sarif.ts:168-208). An absolute path is
positive evidence the file is NOT under the root, since one of the gates
keeps a path absolute exactly when the file is outside the directory it
scanned; stripping the leading slash fabricates a source-root-relative
path pointing at a different file, or at none, and `%SRCROOT%` then
vouches for it. Those get a `file:` uri with no `uriBaseId`. A path still
carrying a `..` segment after normalizing NEVER BECOMES A URI, and the raw
path is kept in the properties bag under `unresolvablePaths` instead. The
normalizing is real rather than a prefix test, so `a/../../b` is caught
too.

Until 0.3.0 such a result had no physical location at all, and that had a
consequence nobody had measured: GitHub code scanning rejects the WHOLE
uploaded log with "locationFromSarifResult: expected at least one
location" as soon as one result has none, so a single location-less result
lost the entire report rather than one alert. Every main-branch run of a
sibling repository's guardrails job carried that annotation, and running
the umbrella against that checkout found the offender.

So every result now carries at least one location, and the fallback is a
real file rather than an invented one: the control file the result is a
statement about (`fallbackLocationFor`, src/output-sarif.ts:301-307, and
`withFallbackLocation`, src/output-sarif.ts:320-331, applied in `toResult`
at src/output-sarif.ts:361). That is the policy file for the umbrella's own
results and for the two gates whose control files the umbrella does not
read, and the frozen contract for the intent gate when the run recorded
which state directory it read. Nothing that already had a location is
touched, no region is invented, and an unresolvable path is still not
turned into a uri, so the two rules above are unchanged rather than
softened. A result that had only a LOGICAL location keeps it and gains the
physical one beside it, since the logical location is what a consumer
groups on.

Pinned by tests/output-sarif.test.ts:1427 (no result in a log built from
every subject shape has an empty locations array), 1437 (every location
resolves to an artifact uri), 1450 (the umbrella's own are filed against
the policy file), 1496 (the intent gate's against its contract), 1526 (a
logical location survives and gains a physical one) and 1544 (a result
that named a real file still points at that file). End to end against the
real gates by tests/dogfood.e2e.test.ts:622.

No invented region. Only the secret gate reports a line and a column, and
even there no `endColumn` (src/output-sarif.ts:257-263 and
src/normalize.ts:291-298).

The reason is narrower than this file used to state it, and the narrower
version is the useful one. That gate DOES know the match length: it
hashes it into its own fingerprint and puts an end column in its own
SARIF. What it omits is `matchLength` on the match object in the JSON
output, which is the one channel the umbrella reads. So the end of the
match is unknown FROM THIS CHANNEL rather than unknown to the product,
which makes it a fixable upstream ask (carry `matchLength` on the match)
rather than a permanent limitation of the finding. Until it is carried it
is not guessed, and the renderer already emits `endColumn` when the
envelope has one (src/output-sarif.ts:261-263), so the day the field
arrives the only change needed is in the normalizer.

`partialFingerprints` carries each product's own fingerprint unhashed,
under a key naming the product and a version
(src/output-sarif.ts:145-147 and 355-357). Hashing it together with
anything would mint a second identity for every finding, one that moves
when the first does not, and every alert would resurface on the next scan.
The key is versioned so a future change to a product's fingerprint inputs
ships as a `/v2` and a consumer can tell the two apart rather than
silently comparing hashes of different things.

`properties.blocking` is the gate's decision as reconciled in
src/normalize.ts and is never recomputed in the renderer
(src/output-sarif.ts:344). A second copy of the gate living in the
renderer would drift silently.

`executionSuccessful` is written whenever the umbrella's run is written,
in both directions (`Invocation`, src/output-sarif.ts:430-441, emitted
unconditionally at src/output-sarif.ts:475 and computed at
src/output-sarif.ts:1011-1013). Emitting it alongside the notifications made
the field present when the answer was true and absent when it was false,
which is the one direction that matters.

Enforcement is recorded in two places and neither is redundant:
`properties.enforced` on the gate's own run, emitted for enforced gates
too so an absent property never has to be read as either answer
(src/output-sarif.ts:935-943), and a notification in the umbrella's run,
which is the only place left to say it for a gate that could not run and
so has no run of its own (src/output-sarif.ts:873-906). What is
deliberately not done is touching the results: a critical finding stays
critical and `blocking` stays whatever the gate decided, because writing
this repository's policy about its own exit code into the field a
code-scanning UI uses to describe a finding would make the finding lie
about what the gate found.

Pinned, claim by claim rather than by a block of numbers, because the
previous list here carried about ten citations that pinned envelope facts
this section never claims and two that belong to the reporting section
above:

- One run per gate, in gate order, with each driver's name and version
  from that gate: tests/output-sarif.test.ts:561 and 569.
- A gate that never ran gets no run: tests/output-sarif.test.ts:887,
  1094 (which also asserts the gate-missing result is still there), 1135
  (a deferred gate), 1161 (no umbrella run when there is nothing to say)
  and 1168 (a gate that ran and found nothing still gets one).
- No invented version: tests/output-sarif.test.ts:576.
- `%SRCROOT%` placement: tests/output-sarif.test.ts:759 (backslashes and
  a leading dot-slash), 776 (an absolute path, posix and Windows, gets a
  `file:` uri and no `uriBaseId`), 803 (an escaping path never becomes a
  uri, is kept in `unresolvablePaths`, and the result falls back to the
  policy file), 829 (one that escapes only after the segments cancel),
  846 (an inner `..` that stays inside), and 860 (a secret finding whose
  file escapes loses its REGION, which is the half that would otherwise
  annotate a line of the wrong file). `placeArtifact` is also exercised
  directly, one rule at a time, at tests/output-sarif.test.ts:1185 to
  1247.
- No invented region: tests/output-sarif.test.ts:711 (a real position
  becomes a region with the 1-based column), 722 (no `startLine` anywhere
  for a finding with no known line), 727 (a path list gets one location
  each and no region) and 741 (a drift finding gets a logical location,
  with the control file beside it and still no region). The absent
  `endColumn` is pinned at the normalizer,
  tests/normalize.test.ts:170.
- `partialFingerprints`: tests/output-sarif.test.ts:660 (keyed by product,
  value unhashed), 669 (stability recorded beside it), 675 (omitted
  entirely when the product mints none) and 1252 (the `/v1` key).
- `properties.blocking` never recomputed: tests/output-sarif.test.ts:622,
  which is the discriminating fixture and the one that matters. Every
  other fixture in that file has blocking agreeing with severity, so a
  renderer that derived blocking from the level would pass all of them;
  this one renders a BLOCKING finding at note level and asserts both. The
  wholesale properties assertion at tests/output-sarif.test.ts:644 cannot
  stand for this claim on its own, which is exactly the gap that let the
  regression through before 622 was written.
- `executionSuccessful` in both directions: tests/output-sarif.test.ts:468
  (false, with no notification to hang it on, which is the case that
  produced no invocation at all before), 479 (true when every gate ran),
  317 (false for a gate that could not run) and 495 (a gate's run gets no
  invocation of its own).
- Enforcement recorded twice, results untouched:
  tests/output-sarif.test.ts:1060 (present on both an enforced and an
  unenforced run), 1070 (the stage beside it), 1080 (the notification),
  1094 (still said for a gate with no run of its own), 1015 (an unenforced
  gate's results keep their own level) and 1027 (a gate that could not run
  keeps an error-level, critical result).

## Blocking is reconstructed, checked against the gate, and the gate wins

Neither dep-guard nor vault-guard marks findings individually. Each
reports the threshold it used and a count of findings at or above it. So
the per-finding flag is RECONSTRUCTED from that threshold on that gate's
own ladder and then CHECKED against that count
(`reconcileBlocking`, src/normalize.ts:103-140).

When the two disagree, every flag drops to false and a diagnostic says
why. The umbrella reporting "blocking" about a finding the tool that
blocks commits disagrees with is the failure the rule exists to prevent.
Nothing about the composed exit code depends on this field either way;
that comes from the child's own exit code, which is the only number the
gate actually decided.

The threshold is read from `run.blocking_matches` for the secret gate and
never from a summary count, because that gate's own documentation says an
integrator gating a build must read the former and that the latter ignores
the threshold. A sibling tool in this family read the summary, and that is
the bug not to copy (src/normalize.ts:238-242 and 331-337).

The intent gate is different in kind and is handled separately: it has no
threshold, so a budget violation is blocking because the gate raises one
reason per violation and blocks on having any reason at all, and a drift
finding is blocking exactly when the OVERALL action blocks, since the gate
raises one reason for the score and none per finding
(src/normalize.ts:519-556 for the budget half and 558-606 for the drift
half).

THE VERDICT HAS A CLAUSE FOR THE STATE THIS RULE PRODUCES, and it was
added after this file was first written. Both branches of
`reconcileBlocking` drop every flag to false while the gate's own non-zero
exit code still stands, and `composeExitCode` returns 1 for a non-zero
gate exit code OR a blocking finding. So a run can exit 1 with nothing on
screen marked blocking, and "verdict: exit 1, 0 blocking finding(s)"
contradicts the number printed beside it on the one line somebody reads
when they read nothing else. That branch instead names the enforced gates
that exited non-zero and says the umbrella could not reconcile a blocking
count with what they reported (src/output-text.ts:494-513).

Pinned by tests/output-text.test.ts:641 and 653, one for each branch of
`reconcileBlocking`, both of which assert the precondition first (the
normalizer marked nothing blocking and raised exactly one diagnostic) and
then that the verdict carries no "0 blocking finding(s)" and does say
which gate exited non-zero. The unenforced aside survives on that verdict
too, tests/output-text.test.ts:665.

Pinned by tests/normalize.test.ts:44 (the reconstructed flags agree with
the count and no diagnostic is raised), 49 (a tampered count makes every
flag drop to false and raises the diagnostic), 62 (the same for a missing
threshold), 184 (the threshold is read from `run.blocking_matches`: with
that count set to 0 the finding is not blocking, while `summary.secrets`
still says 1), 236 (every budget violation blocks), 273 (a drift finding
whose overall action is "proceed" does not) and 421 (a blocked gate never
reports zero blocking findings).

## Nothing invents a position, a fingerprint, or a severity

Severity is carried by identity where the product's ladder is the shared
one and `severityIsDerived` is false; it is the umbrella's own invention
for the intent gate, which has no per-finding severity at all, and
`severityIsDerived` is true there for every finding
(src/envelope.ts:16-23; identity at src/normalize.ts:174-177; the
umbrella's own two ladders for the intent gate at src/normalize.ts:384-401,
marked derived at src/normalize.ts:543, 588 and 628). An unrecognised level
from the secret gate lands on `info` and is marked derived, so a
downstream consumer never sees a level outside the union
(src/normalize.ts:264-277). The text report marks a derived severity with
a trailing asterisk and explains the asterisk only when one is on screen
(src/output-text.ts:49 and 766-768).

Fingerprints are carried verbatim and namespaced by product; nothing is
hashed together with anything else, because a new digest would match no
existing baseline file and would silently invalidate every one in the wild
(src/envelope.ts:25-32). `stability` records what the value is actually
worth: `stable` survives edits elsewhere in the file, `positional` does
not, `none` means there is no id to keep. Where a product mints no
fingerprint, the field is null and no `partialFingerprints` object is
emitted, rather than an invented id no baseline anywhere contains
(src/normalize.ts:632-634).

The umbrella's OWN findings are the one thing it fingerprints, and the
digest is over the rule, the role and the product and deliberately NOT
over the message (src/normalize.ts:728-735), so a repeat run is the same
alert rather than a new one every commit and a reworded detail is not a
new problem. Pinned by tests/normalize.test.ts:460, which asserts two
calls with the same role and product agree and that a different role and
product does not.

`subject` is a union rather than a lowest common denominator
(src/envelope.ts:62-69). Flattening a package, a byte position, a path set
and a contract into file-and-line would mean inventing a line number, and
an invented line number is indistinguishable from a real one once it
reaches a code-scanning UI.

The secret gate's 0-based column becomes 1-based in the envelope, and the
gate's own number is kept in the details bag under a key that names its
base (`columnZeroBased`), because calling it `column` put it next to a
1-based SARIF `startColumn` in the same result where it read as an
off-by-one in this tool (src/normalize.ts:290 for the conversion and 322
for the key).

Pinned by tests/normalize.test.ts:38 (severity by identity, not derived),
204 (an unrecognised level lands on info AND is marked derived), 82 (a
package subject rather than a fabricated file position), 240 (a path list
rather than an invented line number), 90, 176 and 247 (the three
fingerprint stabilities carried verbatim), 147 and 162 (the 1-based
subject column and the 0-based one kept under its own key, with the bag
asserted NOT to carry a plain `column`), 170 (no `endColumn`), 230 (the
intent gate's derived severity and that every one of its findings says
so) and 460 (the umbrella's own deterministic fingerprint).

## No stack trace reaches a terminal or a report

An error's message, never its stack (`messageOf`,
src/gate-runner.ts:527-539; src/normalize.ts:800-830; src/cli.ts:408-427
and 444-447). A stack
reaching the terminal puts a local filesystem path in front of a user who
cannot act on any of it, and puts one into a report that gets uploaded.
The message is the part that says what went wrong.

Pinned by tests/cli.test.ts:98, 116, 130, 141 and 151, and by
tests/run.test.ts:102, which walks the whole outcome object looking for a
stack frame.

## The child's working directory is the repository root

Not a style choice, and it came from running the tools rather than from
reading them. One of the three gates resolves both its config file and its
baseline from the process working directory rather than from its path
argument, so a child spawned from anywhere else scans the right files with
the wrong configuration and the wrong baseline, and says nothing about it.
The other two resolve from their own arguments, so setting the working
directory correctly is the single approach that is right for all three
(src/gate-runner.ts:781-786).

The umbrella anchors everything at the working-tree root as reported by
git, so a run from a subdirectory behaves exactly like a run from the top
(src/cli.ts:62-90). A relative `--output` is the one exception: it
resolves against the directory the command was typed in
(src/cli.ts:399), which is the conventional reading of a path a human
typed, and the generated hook always runs from the root, so only a human
running the CLI by hand from a subdirectory ever hits the difference. The
test proves content equality against absolute paths, which is what keeps
this exception from being a gap in that test.

The child working directory is pinned by tests/gate-runner.test.ts:89.
THE SUBDIRECTORY ANCHORING IS PINNED AT tests/cli.test.ts:399, which runs
the built CLI from `packages/app` two levels inside a repository and
asserts it exits 0, never prints the run-init message, names all three
gates in the report, and writes a report byte for byte identical to the
same run from the top. The equivalent rule inside the generated hook is
pinned at tests/init.test.ts:1546, which runs the hook from `packages/app`
and proves it still finds `node_modules/.bin` at the root.

Every test in tests/cli.test.ts has git on its controlled PATH, and the
reason is worth recording. That file replaces PATH wholesale so the gates
resolve to stubs, which takes git away from the spawned CLI too, and the
CLI needs git to find the root. The shim used to live in the subdirectory
suite alone, because everywhere else the working directory IS the root and
the old fallback made the absence invisible; it now lives in `runCli`
itself, so a spawn site cannot forget it and pass for the wrong reason.

THE FALLBACK IS GONE, and this paragraph used to record it as an OPEN
defect. `repoRoot` no longer catches every failure and answers `cwd`: git
missing from PATH and a directory outside any repository are now two
different sentences, and anything else git can fail with is a third
(src/cli.ts:42-90). It is called inside `run`'s own try, so each one
arrives as one line on stderr with no stack and the could-not-run exit
code, the same shape as every other refusal the CLI makes. What the
fallback did instead was answer "no .guardrails.yaml here, run conductor
init" in a repository that has one, which is a confident answer to a
question nobody asked. The generated hook has always named a missing git
plainly (src/init.ts:507); this is the CLI catching up with it.

ALL THREE BRANCHES ARE PINNED. tests/cli.test.ts:773 (no git on the
controlled PATH: exit 2, the git sentence, no stack frame, no run-init
message, and nothing at all on stdout), 789 (a directory outside any
repository: exit 2 and a sentence naming that directory rather than the
init advice), and 801 (a `git` file with no execute bit on the controlled
PATH: the spawn fails with EACCES, which is neither ENOENT nor an exit
code, and the run says git could not be run rather than either of the
other two sentences).

The third one was written down here as untestable first, and it was
testable in six lines. The claim was that a spawn failure which is neither
ENOENT nor an exit code needs a machine in a state a test cannot ask for;
a file with mode 0 is that state, it is refused for every user including
root, and nothing about the machine has to be arranged. Worth keeping as a
worked example of what this file warns about at the top: an admission of
missing coverage is a claim like any other, and the reason attached to it
is the part most likely to be wrong.

## Public-repository hygiene is a gate, not a habit

This repository is public, so three classes of content must never appear
in a tracked file: a product or venture codename from elsewhere in the
family, a machine-specific absolute path, and a non-ASCII em or en dash.
"Remember not to paste the wrong thing" is not a control, so the
constraint lives in scripts/check-public-hygiene.mjs and runs as
`pnpm lint`, wired into CI at .github/workflows/ci.yml.

The codename list is stored as SHA-256 digests of the lowercased tokens
and never as plaintext, because a plaintext blocklist would itself leak
the names it exists to hide. It is the UNION across the family rather than
a per-repository subset, since a blocklist that differs per repository
protects the intersection and advertises the difference.

Three details of the matching are load-bearing. Tokens are extracted from
a copy with underscores and camelCase humps split apart, because `_` is a
word character to a word boundary and a codename most plausibly appears as
an identifier or an environment variable. The allowlist exempts a file's
CONTENTS from the token and path rules but never its NAME, since the name
is visible on a public file tree either way, and never the dash rule. And
the machine-path pattern requires exactly two segments under any of four
roots, the same rule for all four, after an earlier version used two for
home directories and one for temporary ones and so flagged prose that
merely named a root.

Pinned by scripts/tests/check-public-hygiene.test.mjs, twenty-two cases,
including the mechanism itself against an injected test-only blocklist
(line 193), the compound-word extraction (329, 337, 346), the allowlist
asymmetry (285, 320), and the URL that must not be read as a filesystem
path (156).

Three honest limits. The blocklist is hashes, so nobody can audit its
COVERAGE from inside this repository; only that the mechanism works.
The guard reads `git ls-files`, so the untracked design notes in the
working tree are out of scope by construction, which is correct while they
stay untracked and silently wrong the moment one is added. And there is no
tracked pre-commit hook in this repository running it, so the only
enforcement is CI and whoever remembers to run `pnpm lint` before pushing.

## Things that look like invariants and are not

Recorded so a future audit does not spend time proving them.

Gates run SEQUENTIALLY (src/run.ts:392-484). That is a legibility decision
rather than a rule: interleaved stderr from three gates is unreadable
exactly when a commit has just been refused. It is explicitly flagged in
the source as the obvious thing to revisit with a measurement, and nothing
depends on the ordering.

The per-gate timeout is 120 seconds (src/gate-runner.ts:648) and the child
output buffer is 64MB (src/gate-runner.ts:786). Both are values, not
rules; the only invariant near them is that a timeout lands in the
could-not-run path rather than being read as a clean exit.

`report.format` in the policy file is a default that `--format` overrides
(src/cli.ts:368). There is no rule about which one a repository should
choose.

The `dist/` directory and `schema/` are the published files
(package.json:18-21). The schema ships because a user should be able to
point an editor at it, and because the published contract should be a
thing on disk that can be diffed between releases; that is a reason, not
an invariant anything else depends on.
