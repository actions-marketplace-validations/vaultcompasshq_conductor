// The combined report, for a terminal.
//
// One section per gate in gate order, findings within a gate ordered
// blocking-first, and a one-line verdict at the end. Three things are in
// here deliberately rather than for completeness:
//
//  - Each gate's own threshold is printed in its own section, because
//    there is no shared one and printing a single number would imply there
//    was.
//
//  - The suppressed and ignored counts are printed even when they are
//    zero. Those numbers are the user's own earlier decisions, and hiding
//    them makes a repository with two hundred baselined findings read as
//    clean.
//
//  - A gate that could not run gets a loud section rather than an empty
//    one. An empty section and a clean section look identical at a glance,
//    and that is exactly the confusion that lets a switched-on gate sit
//    uninstalled for months.
//
// No colour and no unicode. This output is read in a pre-commit hook, in
// CI logs, and in pasted issue reports, and the plainest thing that works
// everywhere is worth more here than a nicer-looking terminal.

import { type Finding, compareFindings } from './envelope.js';
import { EXIT_BLOCKED, EXIT_COULD_NOT_RUN } from './exit-codes.js';
import type { GateOutcome } from './gate-runner.js';
import { isLegacyContractPath } from './intent-prepare.js';
import type { RunResult } from './run.js';

function subjectLabel(finding: Finding): string {
  const subject = finding.subject;
  switch (subject.kind) {
    case 'package':
      return `${subject.name} (${subject.manifest})`;
    case 'location':
      return `${subject.file}:${subject.line}:${subject.column}`;
    case 'paths':
      return subject.paths.join(', ');
    case 'contract':
      return subject.category === undefined ? 'intent contract' : `contract: ${subject.category}`;
    case 'none':
      return '';
  }
}

function findingLines(finding: Finding): string[] {
  const marker = finding.blocking ? 'BLOCKING' : '  report';
  const severity = finding.severityIsDerived ? `${finding.severity}*` : finding.severity;
  const subject = subjectLabel(finding);
  const head = `  ${marker}  ${severity.padEnd(9)} ${finding.ruleId}${
    subject === '' ? '' : `  ${subject}`
  }`;
  return [head, `      ${finding.message}`];
}

function header(gate: GateOutcome): string {
  const version = gate.productVersion === null ? '(version unknown)' : gate.productVersion;
  // On the header line rather than only at the bottom of the section: a
  // reader scanning headers for the gate that refused their commit has to
  // be able to see, in the same glance, that this one did not.
  const enforcement = gate.enforce ? '' : '  [not enforced]';
  if (gate.couldNotRun !== null) {
    return `${gate.role}  ${gate.product} ${version}  DID NOT RUN (${gate.couldNotRun.reason})${enforcement}`;
  }
  const source = gate.binary === null ? '' : `  via ${gate.binary.candidate} on ${gate.binary.source}`;
  return `${gate.role}  ${gate.product} ${version}  exit ${gate.exitCode ?? '?'}  ${gate.durationMs}ms${source}${enforcement}`;
}

/**
 * The line that keeps a green exit from being a surprise.
 *
 * A report with BLOCKING on it and exit 0 at the bottom reads as a bug in
 * the umbrella unless the reason is on the same screen, in words rather
 * than in a flag somebody has to go and look up in the policy file.
 */
function enforcementNote(gate: GateOutcome): string | null {
  if (gate.enforce) {
    return null;
  }
  if (gate.couldNotRun !== null) {
    return (
      `  not enforced: this gate could not run, and enforce is false for it in .guardrails.yaml, ` +
      'so it is a note here rather than a failed run. Nothing was checked by it.'
    );
  }
  const blocking = gate.findings.filter((finding) => finding.blocking).length;
  if (blocking > 0 || (gate.exitCode ?? 0) !== 0) {
    return (
      `  not enforced: this gate reported ${blocking} blocking finding(s) and exited ` +
      `${gate.exitCode ?? '?'}, and enforce is false for it in .guardrails.yaml, so the commit ` +
      'proceeds. Set enforce: true there to make it block.'
    );
  }
  return '  not enforced: enforce is false for this gate in .guardrails.yaml. It found nothing to block on here.';
}

/**
 * Where the intent gate's contract came from, and what it measured against.
 *
 * Both halves are on one line and both are always printed when there is a
 * prepared run, including the base. A reader looking at a drift finding has
 * to be able to tell "checked the branch against main using the spec" from
 * "checked the index against a contract in the repository" without opening
 * the policy file or the CI configuration, because those are two different
 * claims and only one of them is about the pull request.
 */
function contractLine(gate: GateOutcome): string | null {
  if (gate.intent === undefined) {
    return null;
  }
  const source = gate.intent.contractSource;
  const where =
    source.kind === 'native'
      ? // The path already names the directory, and the aside says what a
        // reader who has not followed intent-guard's releases cannot get from
        // the path alone: that this is the old name and a newer gate moves it.
        `the repository's own frozen ${source.path}${
          isLegacyContractPath(source.path) ? ' (pre-1.3 directory, still read)' : ''
        }`
      : source.kind === 'imported'
        ? `spec ${source.spec}${source.plan === null ? '' : ` plus plan ${source.plan}`}`
        : 'none';
  const base =
    gate.intent.baseRef === null ? 'base: none, the git index' : `base: ${gate.intent.baseRef}`;
  return `  contract: ${where}   ${base}`;
}

function gateSection(gate: GateOutcome): string[] {
  const lines: string[] = ['', header(gate)];

  const contract = contractLine(gate);
  if (contract !== null) {
    lines.push(contract);
  }

  if (gate.couldNotRun !== null) {
    lines.push(`    ${gate.couldNotRun.detail}`);
    if (gate.stderr.trim().length > 0) {
      for (const line of gate.stderr.trim().split('\n')) {
        lines.push(`    | ${line}`);
      }
    }
  }

  // Sorted here rather than relying on the order the gate happened to emit:
  // blocking first, then by severity. A section whose first line is a low
  // finding buries the one that just refused a commit.
  for (const finding of [...gate.findings].sort(compareFindings)) {
    lines.push(...findingLines(finding));
  }

  if (gate.couldNotRun === null) {
    const threshold =
      gate.run.failOn === null ? 'threshold not reported' : `threshold ${gate.run.failOn}`;
    // "ignored 0" would state a fact the gate never stated for a gate that
    // drops ignored files before they reach its output, and it reads as
    // "nothing was ignored". The normalizer records which is which.
    const ignored =
      gate.run.details.ignoredReported === false
        ? 'ignored not reported'
        : `ignored ${gate.run.ignored}`;
    lines.push(`  ${threshold}   suppressed ${gate.run.suppressed}   ${ignored}`);

    // The gate's own run facts: what it scanned, with what, against what.
    // These were being collected and then dropped.
    //
    // Scalars only. String() on an object gives "[object Object]", and on an
    // empty array gives nothing at all, so a naive render produced both a
    // line of noise and a key with no value. The structured members of this
    // bag (a category breakdown, a reason list) are already in the SARIF
    // details and, for the reasons, in a finding of their own; a terminal
    // summary line is not where they belong.
    const facts = Object.entries(gate.run.details)
      .filter(
        ([key, value]) =>
          // ignoredReported drives the line above rather than being a fact
          // about the run, so it is not printed twice.
          key !== 'ignoredReported' &&
          (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') &&
          value !== ''
      )
      .map(([key, value]) => `${key} ${String(value)}`);
    if (facts.length > 0) {
      lines.push(`  ${facts.join('   ')}`);
    }

    for (const diagnostic of gate.run.diagnostics) {
      lines.push(`  note ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  for (const diagnostic of gate.diagnostics) {
    lines.push(`  ! ${diagnostic.code}: ${diagnostic.message}`);
  }

  // Last in the section, so it is the line under the findings it explains.
  const enforcement = enforcementNote(gate);
  if (enforcement !== null) {
    lines.push(enforcement);
  }

  return lines;
}

/**
 * One line per gate the stage filter held back.
 *
 * Deliberately not a section: nothing ran, so there is no header, no exit
 * code and no duration to put in one. It still has to be on screen, because
 * a run at the commit stage otherwise reads exactly like a run that checked
 * everything, and the whole point of a stage is that some gates did not.
 */
function deferredLines(result: RunResult): string[] {
  return result.deferred.map(
    (gate) =>
      `  deferred  ${gate.role}  ${gate.product}  did not run here; it runs from stage ${gate.stage} onwards`
  );
}

/**
 * One line per gate that had nothing to check.
 *
 * A line rather than silence, and a line rather than a finding. Silence makes
 * a branch with no spec read as a branch that passed the intent gate, which
 * is the confusion this family exists to prevent. A finding would put the
 * absence of a spec on the same footing as a drift, and it is not one: it is
 * the ordinary state of most branches in a repository that has not adopted
 * the flow yet.
 */
function skippedLines(result: RunResult): string[] {
  return result.skipped.map(
    (gate) =>
      `  skipped   ${gate.role}  ${gate.product}  ${skipWording(gate.reason).line}: ${gate.detail}`
  );
}

/**
 * How a skipped gate is worded, in each of the three places it is worded.
 *
 * ONE function rather than a phrase at each call site, because the report has
 * three of them and the first attempt changed one: the full report's own line
 * said "spec waived" while the verdict under it still said "had no contract
 * to check against" and the one-line summary still said "Nothing to check
 * against". Both of those tell a reader to go and write the spec that
 * whoever opened the pull request had just written down there is none of, and
 * the summary line is the one a pre-commit hook and a pull request comment
 * actually print.
 *
 * The `no-contract` wording is unchanged, deliberately: it was right, and a
 * repository on the adoption ramp reads it on most branches.
 */
interface SkipWording {
  /** The label in front of the skipped line in the full report. */
  line: string;
  /** The clause naming what happened, for the verdict sentence. */
  verdict: string;
  /** The lead-in on the one-line summary of an otherwise clean run. */
  summary: string;
}

function skipWording(reason: RunResult['skipped'][number]['reason']): SkipWording {
  return reason === 'contract-waived'
    ? {
        line: 'spec waived',
        verdict: 'had its spec waived by the pull request body',
        summary: 'Spec waived by the pull request body',
      }
    : {
        line: 'no contract',
        verdict: 'had no contract to check against',
        summary: 'Nothing to check against',
      };
}

/**
 * One line per gate the --gate flag left out.
 *
 * The same reasoning as the deferred lines above, with the one difference
 * that there is no later stage to name: this gate is on in the policy file
 * and did not run because of how this one command was typed. Without the
 * line, a --gate run and a full run produce the same report.
 */
function excludedLines(result: RunResult): string[] {
  return result.excluded.map(
    (gate) =>
      `  excluded  ${gate.role}  ${gate.product}  did not run here; --gate did not name it`
  );
}

/**
 * The one sentence the whole of pull-request mode has to fit into.
 *
 * Counted even at ZERO, by the family suppression rule: the number is the
 * answer to "did this pull request also try to change the rules", and leaving
 * it out when the answer is none makes a run in pull-request mode
 * indistinguishable from a run that was never in it.
 */
function proposalCount(result: RunResult): string {
  return `${result.proposals.length} control change(s) proposed in this pull request`;
}

/**
 * The gates the umbrella could not put into pull-request mode.
 *
 * This is the loud half and it must never be silent. A gate here read its own
 * contract, config or baseline out of the tree being judged, which is exactly
 * the hole pull-request mode exists to close, so a run where one gate is
 * still exposed must not read like a run where none is. It is a statement
 * about coverage rather than about anybody's code, so it is a line and a
 * notification rather than a finding, and it never reaches the exit code.
 */
function withheldTrustBase(result: RunResult): Array<{ gate: GateOutcome; reason: string }> {
  return result.gates.flatMap((gate) => {
    const reason = gate.trustBase?.withheld;
    return reason === undefined || reason === null ? [] : [{ gate, reason }];
  });
}

/**
 * The gates whose own node_modules/.bin copy this run declined to take.
 *
 * ONE LINE FOR THE WHOLE RUN rather than one per gate. The fact is about the
 * run's mode, not about any gate's verdict, and in the repository shape it is
 * most likely to happen in, gates installed as devDependencies and nothing
 * else, it is true of all three at once. Three lines saying the same thing
 * would read as three problems.
 */
function nodeModulesSkippedLine(result: RunResult): string[] {
  const skipped = result.gates.flatMap((gate) =>
    gate.nodeModulesSkipped === undefined
      ? []
      : [`${gate.role} (${gate.product}) at ${gate.nodeModulesSkipped}`]
  );
  if (skipped.length === 0) {
    return [];
  }
  return [
    `  node_modules/.bin not consulted: ${skipped.join(', ')}. What is installed there is ` +
      'chosen by the head own manifest and lockfile, so no ref approves it; each of those gates ' +
      'was resolved from PATH or from an absolute command: instead, or reported as could-not-run.',
  ];
}

/**
 * The pull-request-mode block of the full report.
 *
 * Four things in one place, because they answer one question between them:
 * where the rules came from, what this pull request proposes to change them
 * to, which gates were not covered by any of it, and where the programs that
 * did run came from.
 */
function trustBaseLines(result: RunResult): string[] {
  if (result.trustBase === null) {
    return [];
  }
  const lines = [
    `  pull-request mode: rules from ${result.trustBase.ref}. ${proposalCount(result)}.`,
  ];
  for (const proposal of result.proposals) {
    lines.push(`  proposed  ${proposal.product.padEnd(13)} ${proposal.line}`);
  }
  for (const { gate, reason } of withheldTrustBase(result)) {
    lines.push(`  NOT in pull-request mode  ${gate.role}  ${gate.product}  ${reason}`);
  }
  lines.push(...nodeModulesSkippedLine(result));
  return lines;
}

/**
 * What an unenforced gate did, as clauses for a verdict line.
 *
 * Shared by the exit 0 and exit 1 branches: an unenforced gate is left out
 * of the count and out of the reason either way, but it still gets a
 * sentence. A gate that verified nothing is worth a line whatever the exit
 * code turned out to be.
 */
function unenforcedClauses(result: RunResult): string[] {
  const unenforced = result.gates.filter((gate) => !gate.enforce);
  // A gate that could not run is only that. Its findings list carries the
  // umbrella's own blocking gate-missing finding, so a naive test for "has a
  // blocking finding" reports the same gate as having blocked AND as having
  // failed to run, which are opposite claims.
  const blocked = unenforced.filter(
    (gate) =>
      gate.couldNotRun === null &&
      ((gate.exitCode ?? 0) !== 0 || gate.findings.some((finding) => finding.blocking))
  );
  const broken = unenforced.filter((gate) => gate.couldNotRun !== null);

  const clauses: string[] = [];
  if (blocked.length > 0) {
    clauses.push(`${blocked.map((gate) => gate.role).join(', ')} blocked`);
  }
  if (broken.length > 0) {
    clauses.push(`${broken.map((gate) => gate.role).join(', ')} could not run`);
  }
  return clauses;
}

/**
 * The refusal, as the first line of the report and as the verdict.
 *
 * FIRST, and before any question about how many gates there are. The old
 * order asked that question first, and an inventory naming no gate -- every
 * gate `enabled: false` in the head's file, or a head file that will not
 * parse -- fell into the "no gate ran because none is enabled" branch, which
 * printed exit 0 and told the reader to switch a gate on while the process
 * exited 2 and nothing had been checked. The refusal is the whole story of
 * such a run and there is no arrangement of the other clauses that tells it.
 */
function refusalLines(result: RunResult): string[] {
  const refusal = result.trustBase?.refusal;
  if (refusal === undefined || refusal === null) {
    return [];
  }
  return [
    `conductor: refused the trust base "${result.trustBase?.ref ?? ''}". Nothing was checked.`,
    `  ${refusal}`,
  ];
}

function verdict(result: RunResult): string {
  const refusal = result.trustBase?.refusal;
  if (refusal !== undefined && refusal !== null) {
    // Written rather than composed, exactly as the exit code is: no gate ran,
    // so there is nothing for the clauses below to count, and every one of
    // them would describe a different run from the one that happened.
    return (
      `verdict: exit 2, the trust base "${result.trustBase?.ref ?? ''}" could not be used, ` +
      'so no gate ran and nothing here is a result of any kind.'
    );
  }
  return verdictForRun(result);
}

function verdictForRun(result: RunResult): string {
  // Counted over ENFORCED gates only. The exit code came from those alone,
  // so a count taken over all of them describes a different run from the one
  // the number at the front of the line is about, and the umbrella's own
  // findings about an unenforced broken gate inflate it further.
  const enforcedGates = result.gates.filter((gate) => gate.enforce);
  const blocking = enforcedGates
    .flatMap((gate) => gate.findings)
    .filter((finding) => finding.blocking).length;

  if (result.gates.length === 0 && result.deferred.length > 0) {
    // Distinct from "none is enabled" below. A policy file with everything
    // switched off and a stage with nothing to do at it are two different
    // states, and telling somebody to set enabled: true is the wrong advice
    // for the second one.
    const names = result.deferred.map((gate) => `${gate.role} at stage ${gate.stage}`).join(', ');
    return `verdict: exit 0, nothing ran at this stage: every enabled gate is deferred (${names}).`;
  }
  if (result.gates.length === 0 && result.skipped.length > 0) {
    // A third distinct state, and telling somebody to switch a gate on is
    // wrong advice here too: the gate IS on, it ran, and it had nothing to
    // check. What to do about that is NOT the same in both cases, which is
    // why the clause comes from the skip reason rather than being written
    // here: for a missing spec the fix is to write one, and for a waiver
    // there is nothing to fix, because a person decided it.
    const clauses = result.skipped
      .map((gate) => `${gate.role} ${skipWording(gate.reason).verdict}`)
      .join(', ');
    return `verdict: exit 0, nothing was checked: ${clauses}.`;
  }
  if (result.gates.length === 0) {
    // Exit 0 with an empty report is indistinguishable from a clean run at a
    // glance, and a policy file with every gate switched off is exactly the
    // state somebody needs told about. Still 0: nothing was asked for and
    // nothing failed, so this is not the umbrella's decision to overturn.
    return (
      'verdict: exit 0, no gate ran because none is enabled. ' +
      'Nothing was checked. Set enabled: true on a gate in .guardrails.yaml.'
    );
  }
  const clauses = unenforcedClauses(result);
  const aside =
    clauses.length === 0
      ? ''
      : ` ${clauses.join(' and ')}, but those gates have enforce: false in .guardrails.yaml, ` +
        'so that is not why.';

  if (result.exitCode === EXIT_COULD_NOT_RUN) {
    // Only the ENFORCED gates. An unenforced gate that could not run is not
    // why this run failed, and naming it here sends somebody off to install
    // a gate that would not have changed the answer.
    const names = enforcedGates
      .filter((gate) => gate.couldNotRun !== null)
      .map((gate) => gate.role)
      .join(', ');
    return `verdict: exit 2, a gate could not run (${names}), so nothing here is a clean result.${aside}`;
  }
  if (result.exitCode === EXIT_BLOCKED) {
    // Exit 1 with nothing on screen marked blocking. The sibling of the exit 0
    // clause below, and it exists for the same reason: composeExitCode returns
    // 1 for a non-zero gate exit code OR a blocking finding, and both branches
    // of reconcileBlocking in normalize.ts drop every blocking flag to false
    // while the gate's own non-zero exit still stands. "0 blocking finding(s)"
    // on the one line somebody reads when they read nothing else contradicts
    // the exit code printed beside it, and sends a reader looking for a
    // finding that this report deliberately does not claim.
    if (blocking === 0) {
      const names = enforcedGates
        .filter((gate) => (gate.exitCode ?? 0) !== 0)
        .map((gate) => `${gate.role} (exit ${gate.exitCode ?? '?'})`)
        .join(', ');
      return (
        `verdict: exit 1, and no finding here is marked blocking. Enforced gate(s) that exited ` +
        `non-zero: ${names}. The umbrella could not reconcile a blocking count with what those ` +
        `gates reported, so the gate exit code decided the run.${aside}`
      );
    }
    return `verdict: exit 1, ${blocking} blocking finding(s) across ${enforcedGates.length} gate(s).${aside}`;
  }

  // Exit 0 with red on the screen above it. The verdict is the one line
  // somebody reads when they read nothing else, so it is the line that has
  // to carry the reason rather than leaving it to the sections.
  if (clauses.length > 0) {
    return (
      `verdict: exit 0, but ${clauses.join(' and ')}. ` +
      'Those gates have enforce: false in .guardrails.yaml, so nothing here failed the run.'
    );
  }

  return `verdict: exit 0, every enabled gate ran and none blocked.`;
}

export interface TextOptions {
  /**
   * Print the full report even when the run is fully clean.
   *
   * A flag on the command line rather than a key in the policy file. The
   * schema describes what a repository gates on, and how loud one developer
   * wants their own terminal to be is not that.
   */
  verbose?: boolean;

  /**
   * The umbrella's own package version, printed as the first line of the
   * full report. This text report is also the pull-request comment body,
   * and without this line nothing on it says which conductor produced it.
   *
   * Left out of the one-line clean summary on purpose: that line is kept to
   * one line by design, and the version is not the fact a clean run needs to
   * lead with. Omitted entirely (no line at all) when no version is given,
   * so a caller that does not pass one sees the same report as before.
   */
  version?: string;

  /**
   * Renders a short body instead of the full report when the trust base was
   * refused and no gate ran: the version, the verdict sentence, and every
   * refusal detail line the full report would have printed for this case
   * (`refusalLines`) -- which is the reason and, when the base ref carries
   * no policy file at all, the remedy that reason names. There is no
   * pointer at a step log: a fork's read-only token cannot even show the
   * commenter that log, so the reason has to be ON the comment rather than
   * behind a link to one.
   *
   * Built for the pull-request-comment step. Its whole point is otherwise a
   * full sticky comment whose only content is "the trust base was refused,
   * nothing was checked" -- true, but not worth the ceremony of the full
   * per-gate report on every push. Every other run is unaffected: this only
   * fires when the trust base was actually refused, whatever --verbose says.
   */
  compact?: boolean;
}

/**
 * Whether this run has nothing at all to report.
 *
 * Three conditions, and the second and third are why this is not just a test
 * of the exit code. A gate with enforce: false is left out of the composed
 * code entirely, so a run where such a gate blocked, or could not run at
 * all, still exits 0; collapsing those to one "clean" line would silently
 * swallow the only report of them anybody sees.
 *
 * A GATE'S OWN NOTES ARE NOT IN HERE; THE UMBRELLA'S OWN DIAGNOSTICS ARE.
 * The two are printed with different markers in the full report and the
 * difference is real. A statement about how much of the policy a run covered
 * is a notification: the standing note that pnpm lockfiles do not record
 * install-script metadata is a permanent property of that file format, true
 * on every run forever, and forcing a screenful over it would make the
 * summary line useless in the repositories that most need it. A statement
 * that something went wrong is a result: conductor/blocking-count-mismatch
 * and conductor/blocking-threshold-unknown, the two codes reconcileBlocking
 * raises in normalize.ts, are the umbrella saying its own report may disagree
 * with the gate's own verdict about what blocked, which is a defect in THIS
 * run and cannot be reported as a number on a line that also says "clean,
 * nothing blocked".
 *
 * A run where no gate ran at all is not clean either, whatever the exit code
 * says. "No gate ran because none is enabled", "every gate was deferred" and
 * "nothing had a contract to check" are three distinct states somebody needs
 * telling about, and a summary line that named no gates would be the exact
 * confusion this family exists to prevent.
 */
function isFullyClean(result: RunResult): boolean {
  if (result.exitCode !== 0 || result.gates.length === 0) {
    return false;
  }
  return result.gates.every(
    (gate) =>
      gate.couldNotRun === null &&
      (gate.exitCode ?? 0) === 0 &&
      gate.diagnostics.length === 0 &&
      !gate.findings.some((finding) => finding.blocking)
  );
}

/**
 * The gates' own notes, and only those.
 *
 * The umbrella's own diagnostics are deliberately not added in. They force
 * the full report instead, by the rule on isFullyClean above, so a count of
 * them here would be a count of something that can never be on this line.
 */
function noteCount(result: RunResult): number {
  return result.gates.reduce((total, gate) => total + gate.run.diagnostics.length, 0);
}

/**
 * The whole report of a clean run, on one line.
 *
 * The v0.2 design constraint is that the gates must not slow development
 * down, and the cost it names is ceremony rather than runtime. Twelve lines
 * of per-gate detail on a commit that found nothing is that cost, paid on
 * every commit, and it is what makes a team switch a hook off. What it must
 * still carry: which gates actually ran, which ones did not run here, and
 * that there is more to read. Everything else waits for --verbose.
 */
function summaryLine(result: RunResult): string {
  const ran = result.gates.map((gate) => `${gate.role} (${gate.product})`).join(', ');
  const parts = [`conductor: clean, nothing blocked. ${result.gates.length} gate(s) ran: ${ran}.`];

  if (result.deferred.length > 0) {
    const names = result.deferred
      .map((gate) => `${gate.role} (${gate.product}) from stage ${gate.stage}`)
      .join(', ');
    parts.push(`Deferred to a later stage: ${names}.`);
  }

  // Same reasoning as the deferred clause. A gate that ran and had nothing to
  // check covered none of this commit, and silence there makes a branch with
  // no spec read as a branch that passed the intent gate.
  //
  // One clause per REASON, not one clause for all of them. This line is the
  // whole report on a clean run, which is what a pre-commit hook and a pull
  // request comment print, so a shared "nothing to check against" would hide
  // the difference between nobody having written a spec and somebody having
  // decided there is none exactly where most readers stop reading. Grouped in
  // first-seen order so the sentence does not reorder itself between runs.
  const skippedByWording = new Map<string, string[]>();
  for (const gate of result.skipped) {
    const lead = skipWording(gate.reason).summary;
    skippedByWording.set(lead, [
      ...(skippedByWording.get(lead) ?? []),
      `${gate.role} (${gate.product})`,
    ]);
  }
  for (const [lead, names] of skippedByWording) {
    parts.push(`${lead}: ${names.join(', ')}.`);
  }

  // Same reasoning again, for the gates the command line left out. This one
  // is the easiest of the three to lose: a --gate run is usually somebody
  // narrowing a run on purpose, and a log of it that says nothing about the
  // narrowing is the log that gets uploaded and read as a full run later.
  // Counted even at zero for the same suppression reason as the enforcement
  // count above: a gate the command line dropped had no vote, and "0 gate(s)
  // left out by --gate" says the run was not narrowed.
  if (result.excluded.length > 0) {
    const names = result.excluded.map((gate) => `${gate.role} (${gate.product})`).join(', ');
    parts.push(`${result.excluded.length} gate(s) left out by --gate: ${names}.`);
  } else {
    parts.push('0 gate(s) left out by --gate.');
  }

  // A gate that ran with enforce: false could not have failed this run
  // whatever it found. Naming it among the gates that ran and then saying
  // nothing more makes a repository on the adoption ramp read as fully
  // gated, and being fully gated is exactly what the ramp is not yet. The
  // full report says this in the line under that gate's findings; on a clean
  // run there are no findings, so the summary line is the only place left to
  // say it.
  //
  // Printed as a count even when it is zero. This is the family suppression
  // rule: a gate that can be turned off is the user's decision, and a clean
  // line that says nothing about enforcement lets a repository read as fully
  // gated when a gate's result did not move the exit code. "0 gate(s) not
  // enforced" is the umbrella saying every gate that ran had a vote.
  const unenforced = result.gates.filter((gate) => !gate.enforce);
  if (unenforced.length > 0) {
    const names = unenforced.map((gate) => `${gate.role} (${gate.product})`).join(', ');
    parts.push(
      `${unenforced.length} gate(s) not enforced, could not have blocked, enforce: false in .guardrails.yaml: ${names}.`
    );
  } else {
    parts.push('0 gate(s) not enforced.');
  }

  // Non-blocking findings are counted rather than hidden, for the same reason
  // the full report prints the suppressed and ignored counts at zero: they
  // are things the gates actually said, and a summary that omitted them would
  // let a repository accumulate them unread.
  const counts: string[] = [];
  if (result.findings.length > 0) {
    counts.push(`${result.findings.length} non-blocking finding(s)`);
  }
  const notes = noteCount(result);
  if (notes > 0) {
    counts.push(`${notes} note(s)`);
  }
  if (counts.length > 0) {
    parts.push(`${counts.join(', ')}.`);
  }

  // The suppressed and ignored counts the gates reported, summed across them
  // and printed even at zero. The full report prints these per gate for the
  // same reason, so a quiet report is not mistaken for a clean one; the clean
  // summary line is the one a hook and a pull request comment actually print,
  // and it is where a repository baselining findings without saying so would
  // otherwise read as clean. Suppressed always shows because it is always a
  // number the gate reported. Ignored shows only when every gate that ran
  // reported it: a gate that drops ignored files before its own output has no
  // count to give, and "0 ignored" there would state a fact no gate stated.
  const suppressed = result.gates.reduce((total, gate) => total + gate.run.suppressed, 0);
  const gatesReportingIgnored = result.gates.filter(
    (gate) => gate.run.details.ignoredReported !== false
  );
  const ignored = gatesReportingIgnored.reduce((total, gate) => total + gate.run.ignored, 0);
  parts.push(
    gatesReportingIgnored.length === result.gates.length
      ? `${suppressed} suppressed, ${ignored} ignored across all gates.`
      : `${suppressed} suppressed across all gates.`
  );

  // Pull-request mode, on the one line a hook and a pull request comment
  // actually print. A clean run is exactly where this matters most: a pull
  // request that proposes to switch a gate off and carries nothing else
  // produces a clean report, and without this clause the only trace of the
  // attempt would be in a file nobody re-reads.
  if (result.trustBase !== null) {
    parts.push(`Rules from ${result.trustBase.ref}. ${proposalCount(result)}.`);
    const withheld = withheldTrustBase(result);
    if (withheld.length > 0) {
      const names = withheld.map(({ gate }) => `${gate.role} (${gate.product})`).join(', ');
      parts.push(`${withheld.length} gate(s) NOT in pull-request mode: ${names}.`);
    }
  }

  parts.push('Re-run with --verbose for the full report.');
  return parts.join(' ');
}

/**
 * The version line, as the first line of every report that carries one.
 *
 * One function rather than one literal at each of the two call sites below:
 * the compact body and the full report both lead with it, and a change to
 * the line's wording only needs one edit to stay in sync between them.
 */
function versionLine(version: string | undefined): string[] {
  return version === undefined ? [] : [`conductor ${version}`];
}

export function renderText(result: RunResult, options: TextOptions = {}): string {
  const refusal = refusalLines(result);

  if (options.compact === true && refusal.length > 0) {
    // The version, then the verdict sentence, then EVERY refusal detail
    // line the full report would have printed for this case -- refusalLines
    // itself, which already carries the base-ref-specific remedy (running
    // "conductor init", or reading the pull request's own file as a
    // proposal) as part of the same sentence. Nothing here points at a step
    // log: the reason has to be readable on the comment itself.
    const lines: string[] = [...versionLine(options.version), verdict(result), ...refusal];
    return `${lines.join('\n')}\n`;
  }

  if (refusal.length === 0 && !options.verbose && isFullyClean(result)) {
    return `${summaryLine(result)}\n`;
  }

  // Counted over EVERY gate, unenforced ones included, and deliberately not
  // the same number the verdict prints. This line is an inventory of what
  // follows it: a reader counting the finding lines on screen has to arrive
  // at this number, and narrowing it to the enforced gates would make the
  // header disagree with the report under it. The verdict is the other
  // question, what failed the run, and that one is enforced gates only. Two
  // different questions, so two numbers, and the section headers and the
  // "not enforced" lines are what connect them.
  const lines: string[] = [
    ...versionLine(options.version),
    ...refusal,
    ...(refusal.length === 0 ? [] : ['']),
    `conductor run: ${result.gates.length} gate(s), ${result.findings.length} finding(s)`,
  ];

  for (const gate of result.gates) {
    lines.push(...gateSection(gate));
  }

  const aside = [...deferredLines(result), ...skippedLines(result), ...excludedLines(result)];
  if (aside.length > 0) {
    lines.push('', ...aside);
  }

  const trust = trustBaseLines(result);
  if (trust.length > 0) {
    lines.push('', ...trust);
  }

  // A derived severity is marked with a trailing asterisk above; say what
  // that means rather than leaving a reader to guess, and only when one is
  // actually on screen.
  if (result.findings.some((finding) => finding.severityIsDerived)) {
    lines.push('', '* severity assigned by the umbrella; that gate reports no per-finding severity.');
  }

  lines.push('', verdict(result));
  return `${lines.join('\n')}\n`;
}
