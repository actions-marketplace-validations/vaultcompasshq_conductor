#!/usr/bin/env node
// The umbrella's command-line entry point: two commands, "init" and "run".
//
// Nothing here decides anything. init.ts decides what to write, run.ts
// decides what to run, exit-codes.ts decides the exit code, and this file
// parses arguments and prints. That split is what lets every one of those
// decisions be tested without a subprocess.

import { Command, CommanderError } from 'commander';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_COULD_NOT_RUN } from './exit-codes.js';
import {
  applyInit,
  planInit,
  renderInitHuman,
  renderRevertHuman,
  revertInit,
} from './init.js';
import { renderSarif } from './output-sarif.js';
import { renderText } from './output-text.js';
import {
  GATE_ROLES,
  GATE_STAGES,
  POLICY_FILE_NAME,
  PolicyError,
  applyCliOverrides,
  loadPolicy,
  parsePolicy,
} from './policy.js';
import type { CliOverrides, GateRole, GateStage, Policy } from './policy.js';
import { refusedTrustBase, runAll } from './run.js';
import type { RunTrustBase } from './run.js';
import { policyDiffers, readPolicyAtRef, refuseTrustBaseRef } from './trust-base.js';

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

/**
 * The working-tree root, or a thrown one-line diagnosis of why there is none.
 *
 * The policy file, the hook, and every child's working directory are all
 * anchored at the working-tree root, so a run from a subdirectory behaves
 * exactly like a run from the top.
 *
 * This used to catch everything and return the working directory. Two quite
 * different failures hid in that: git is not on PATH, and this directory is
 * not inside a repository. Both then produced "no .guardrails.yaml here, run
 * conductor init" from a subdirectory of a repository that has one, which is
 * a confident answer to a question nobody asked. The generated hook has
 * always named a missing git in its own words (src/init.ts), for the same
 * reason.
 *
 * Errors rather than a fallback root, because the alternative is silently
 * gating a commit against the wrong tree. `run`'s own catch turns these into
 * one line on stderr with no stack and the could-not-run exit code, so
 * nothing here has to know about either.
 */
function repoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'git is not on PATH, so the repository root could not be found. Install git, or ' +
          'run conductor from a shell that has it.'
      );
    }
    if (typeof (err as { status?: unknown }).status === 'number') {
      // git ran and refused. The directory is named because it is the one
      // thing the reader has to check, and it is the directory they typed
      // the command in rather than anything internal to this tool.
      throw new Error(
        `not a git repository: ${cwd}. conductor anchors every gate at the working-tree ` +
          'root, so run it inside a checkout.'
      );
    }
    // git is there and never got as far as an exit code: a permissions
    // problem, or a machine out of processes. Neither of the two sentences
    // above would be true, so this says what actually happened.
    throw new Error(`git could not be run to find the repository root: ${(err as Error).message}`);
  }
}

interface RunCliOptions {
  staged?: boolean;
  format: string;
  gate?: string[];
  stage?: string;
  base?: string;
  trustBase?: string;
  spec?: string;
  output?: string;
  verbose?: boolean;
  compactOnRefusal?: boolean;
}

/**
 * The policy for one run, and where it came from.
 *
 * Two shapes rather than one, because a run that could not use its trust base
 * is not a run with a different policy: it is a run with NO policy, and it
 * has to report every enabled gate as could-not-run rather than fall back to
 * the head's file.
 */
type PolicyForRun =
  | { kind: 'policy'; policy: Policy; trustBase?: RunTrustBase }
  /** The trust base could not be judged against. `inventory` only names gates. */
  | { kind: 'refused'; ref: string; detail: string; inventory: Policy };

/**
 * Reads the policy for one run, from the base ref in pull-request mode.
 *
 * THE HEAD'S POLICY FILE IS NEVER PARSED INTO A RUN IN PULL-REQUEST MODE, and
 * that is the whole of the fix. A pull request that rewrites `.guardrails.yaml`
 * to point a gate's `command:` at a script it added, or to switch off the gate
 * that would have caught what else is in the commit, gets the base ref's
 * policy and a line saying its own was proposed.
 *
 * The head's file is read for exactly two things, neither of which can change
 * what runs: it is compared with the base's so the difference can be
 * reported, and, when the trust base itself cannot be used, it names the
 * gates the report says did not run.
 */
/**
 * An inventory, and only an inventory: a list of gate NAMES for the report,
 * taken from the one file available when the trust base itself cannot supply
 * a policy. It is head-controlled, so it can be SHORTER as well as longer
 * than the base's -- every gate `enabled: false`, or a file that will not
 * parse at all, leaves it empty.
 *
 * Neither direction can weaken the verdict, and that is the property this
 * rests on rather than on the inventory being right. refusedTrustBase
 * enforces every gate it names and writes exit 2 itself, and the refusal is
 * carried on the result so both renderers lead with it whether the inventory
 * names three gates or none. A longer list makes the report longer; a
 * shorter one makes it shorter; the verdict is the same sentence either way.
 *
 * An unreadable head file leaves the list empty rather than throwing: the
 * trust base is what went wrong, and reporting the head's malformed file
 * would send the reader to the wrong fix on a run that would have ignored
 * that file anyway.
 */
function inventoryFromHead(root: string, overrides: CliOverrides): Policy {
  try {
    return applyCliOverrides(loadPolicy(root), overrides);
  } catch {
    return { version: 1, gates: {}, report: { format: 'text' } };
  }
}

function policyForRun(
  root: string,
  trustBase: string | undefined,
  overrides: CliOverrides
): PolicyForRun {
  if (trustBase === undefined) {
    return { kind: 'policy', policy: applyCliOverrides(loadPolicy(root), overrides) };
  }

  const refusal = refuseTrustBaseRef(root, trustBase);
  if (refusal !== null) {
    return {
      kind: 'refused',
      ref: trustBase,
      detail: refusal,
      inventory: inventoryFromHead(root, overrides),
    };
  }

  const baseText = readPolicyAtRef(root, trustBase);
  const headText = readPolicyAtRef(root, 'HEAD');

  if (baseText === null) {
    // CONFIG ABSENT ON THE BASE, not a policy error thrown from here. The old
    // shape threw a PolicyError, which the run command's catch prints as one
    // line on STDERR and nothing else: no report on stdout, no SARIF file
    // written, exit code 2 by accident of `fail()` rather than by the same
    // could-not-run machinery every other trust-base failure goes through.
    // Two real adopters, running in advisory mode, hit exactly this on their
    // first pull request -- before "conductor init" had ever landed on their
    // base branch -- and read a red step with an empty report as either
    // nothing to see or a broken tool, never as "finish adopting".
    //
    // This is DISCOVERED-empty, not IMPOSED-empty: nobody wrote a policy file
    // down and disabled every gate in it, the base ref simply has none yet.
    // That is the same "nothing here is a result of any kind" shape as a base
    // ref that will not resolve, so it goes through the exact same
    // refusedTrustBase reporting: could-not-run (exit 2), the reason on the
    // text report and in the SARIF log, and the head's own gates named as not
    // having run. A base ref whose file is merely ABSENT must not be treated
    // more gently than one that will not resolve at all; both mean this run
    // has no policy to have been judged by.
    //
    // CONTRAST: a base ref that DOES carry a policy file in which the user
    // switched every gate off, or deferred them all past this stage, is left
    // alone below in the ordinary `runAll` path and keeps reporting a clean
    // exit 0 -- see the "no gate ran because none is enabled" verdict in
    // output-text.ts. That is an IMPOSED-empty state, a decision written down
    // on the base branch on purpose, and mirrors the no-contract
    // (discovered, write one) vs contract-waived (imposed, a person already
    // decided) distinction the intent gate already makes for a missing spec.
    const detail =
      `No ${POLICY_FILE_NAME} on "${trustBase}". On a pull-request run every rule comes from the ` +
      'base ref, so this run has no policy at all and nothing was checked. ' +
      (headText === null
        ? `Run "conductor init" on the base branch.`
        : `The ${POLICY_FILE_NAME} in this pull request is a proposal: it decides what runs ` +
          'once it is on the base branch, and never on the pull request that adds it.');
    return {
      kind: 'refused',
      ref: trustBase,
      detail,
      inventory: inventoryFromHead(root, overrides),
    };
  }

  return {
    kind: 'policy',
    policy: applyCliOverrides(
      parsePolicy(baseText, `${trustBase}:${POLICY_FILE_NAME}`),
      overrides
    ),
    trustBase: {
      ref: trustBase,
      policyChanged: policyDiffers(baseText, headText),
      refusal: null,
    },
  };
}

function parseFormat(value: string): 'text' | 'sarif' {
  if (value !== 'text' && value !== 'sarif') {
    throw new PolicyError(`--format must be "text" or "sarif", got "${value}".`);
  }
  return value;
}

/**
 * An unknown stage is a usage error, never a silent full run.
 *
 * The dangerous failure here is the quiet one. A typo in a CI file that
 * makes the job run every gate reads as a passing build with more coverage
 * than it has, and a typo that makes it run none reads as a passing build
 * with no coverage at all. Both look like success.
 */
function parseStage(value: string | undefined): GateStage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(GATE_STAGES as readonly string[]).includes(value)) {
    throw new PolicyError(`--stage must be one of ${GATE_STAGES.join(', ')}, got "${value}".`);
  }
  return value as GateStage;
}

function parseRoles(values: string[] | undefined): GateRole[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  for (const value of values) {
    if (!(GATE_ROLES as readonly string[]).includes(value)) {
      throw new PolicyError(`--gate must be one of ${GATE_ROLES.join(', ')}, got "${value}".`);
    }
  }
  return values as GateRole[];
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return EXIT_COULD_NOT_RUN;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('conductor')
    .description('One policy file, one hook, and one report over independently installed gates.')
    .version(pkg.version)
    // Without this, commander calls process.exit() itself on any usage
    // problem, which makes the CLI untestable in-process and bypasses the
    // exit-code vocabulary the rest of this tool uses.
    .exitOverride();

  program
    .command('init')
    .description(
      'Write the policy file and one pre-commit hook that runs the commit-stage gates.'
    )
    .option('--dry-run', 'print every file that would be written or changed, and write nothing')
    .option('--adopt', "replace a gate's own pre-commit hook with the umbrella hook")
    .option('--revert', 'remove exactly what a previous init wrote')
    .option(
      '--force',
      'act on a file that has changed since init wrote it: replace a managed hook somebody has edited, or with --revert remove one and restore any adopted hook'
    )
    .option('--json', 'print the result as JSON')
    .exitOverride()
    .action(
      (options: {
        dryRun?: boolean;
        adopt?: boolean;
        revert?: boolean;
        force?: boolean;
        json?: boolean;
      }) => {
        const cwd = process.cwd();
        const shared = { cwd, pathValue: process.env.PATH ?? '' };

        if (options.revert) {
          const result = revertInit({
            ...shared,
            force: Boolean(options.force),
            dryRun: Boolean(options.dryRun),
          });
          const rendered = `${renderRevertHuman(result)}\n`;
          if (options.json) {
            process.stdout.write(`${JSON.stringify(result)}\n`);
          } else if (result.ok) {
            process.stdout.write(rendered);
          } else {
            // A partial revert left something behind, so it is not success
            // output. Writing it to stdout would let a script pipe it past a
            // reader who needed to see it.
            process.stderr.write(rendered);
          }
          process.exitCode = result.ok ? 0 : EXIT_COULD_NOT_RUN;
          return;
        }

        const initOptions = {
          ...shared,
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
          ...(options.force === undefined ? {} : { force: options.force }),
        };
        const result = applyInit(planInit(initOptions), initOptions);

        if (options.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else if (result.ok) {
          process.stdout.write(`${renderInitHuman(result)}\n`);
        } else {
          process.stderr.write(`${renderInitHuman(result)}\n`);
        }
        process.exitCode = result.ok ? 0 : EXIT_COULD_NOT_RUN;
      }
    );

  program
    .command('run')
    .description('Run every enabled gate and print one combined report.')
    .option('--staged', 'gate the git index against HEAD, the way the pre-commit hook does')
    .option('--format <format>', 'output format: text or sarif')
    .option(
      '--stage <stage>',
      `which stopping point this run is: ${GATE_STAGES.join(', ')}. Stages are cumulative, so a gate runs at its own stage and every later one. Omit it to run every enabled gate.`
    )
    .option(
      '--base <ref>',
      'measure the intent gate against what this branch changed since <ref>, rather than against the index. In Actions this defaults to origin/<GITHUB_BASE_REF> when it is set.'
    )
    .option(
      '--trust-base <ref>',
      'pull-request mode: read .guardrails.yaml from this ref instead of from the tree being judged, and pass the same ref to every gate that supports it. A policy change in the pull request is reported as a proposal and never takes effect for the run, so a pull request cannot change the rules it is judged by. In Actions the composite action passes origin/<GITHUB_BASE_REF> on a pull_request event.'
    )
    .option(
      '--output <path>',
      'write the report to this file instead of to stdout, for a CI step that uploads it'
    )
    .option(
      '--spec <path>',
      'the spec the intent gate imports its contract from, outranking a Spec: line in the pull request body and the branch-name convention'
    )
    .option(
      '--verbose',
      'print the full per-gate report even when the run is clean. A clean run prints one summary line by default, because a pre-commit hook that prints a screenful on every commit is a hook a team switches off. Text output only; SARIF is unaffected.'
    )
    .option(
      '--compact-on-refusal',
      'when the trust base was refused and no gate ran, print three lines instead of the full refusal report: the version, the could-not-run reason, and a pointer at the step log. Built for the pull-request-comment step; every other run is unaffected, whatever --verbose says. Text output only; SARIF is unaffected.'
    )
    .option(
      '--gate <role>',
      'restrict the run to this role; repeatable',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .exitOverride()
    .action((options: RunCliOptions) => {
      const cwd = process.cwd();

      try {
        // Inside the try, because repoRoot now reports rather than guesses,
        // and the catch below is what turns any of its three sentences into
        // one line on stderr and the could-not-run exit code.
        const root = repoRoot(cwd);
        const overrides: CliOverrides = {
          ...(parseRoles(options.gate) === undefined
            ? {}
            : { gates: parseRoles(options.gate) as GateRole[] }),
        };
        const stage = parseStage(options.stage);
        const source = policyForRun(root, options.trustBase, overrides);
        const policy = source.kind === 'policy' ? source.policy : source.inventory;
        const format = parseFormat(options.format ?? policy.report.format);

        const result =
          source.kind === 'refused'
            ? refusedTrustBase(source.inventory, source.ref, source.detail, {
                ...(stage === undefined ? {} : { stage }),
              })
            : runAll(source.policy, {
                repoRoot: root,
                staged: Boolean(options.staged),
                pathValue: process.env.PATH ?? '',
                env: process.env,
                ...(stage === undefined ? {} : { stage }),
                ...(options.base === undefined ? {} : { base: options.base }),
                ...(options.spec === undefined ? {} : { spec: options.spec }),
                ...(source.trustBase === undefined ? {} : { trustBase: source.trustBase }),
              });

        const rendered =
          format === 'sarif'
            ? `${renderSarif(result, pkg.version)}\n`
            : renderText(result, {
                verbose: Boolean(options.verbose),
                version: pkg.version,
                compact: Boolean(options.compactOnRefusal),
              });

        if (options.output === undefined) {
          process.stdout.write(rendered);
        } else {
          // A failure to write is the umbrella not carrying out what it was
          // asked, so it takes the could-not-run code rather than the run's
          // own. Reporting exit 0 next to a report nobody can read is the
          // worst of the available answers: the upload step downstream would
          // fail on a missing file with no explanation here.
          writeFileSync(options.output, rendered);
          // One line, so a CI job whose only product is an uploaded artifact
          // does not read as a job that did nothing.
          process.stdout.write(
            `conductor run: ${result.gates.length} gate(s), ${result.findings.length} finding(s); ` +
              `${format} report written to ${options.output}\n`
          );
        }
        process.exitCode = result.exitCode;
      } catch (err) {
        // One line, never a stack. runGate is total, so nothing from a gate
        // reaches here; anything that does is the umbrella's own problem and
        // still must not put a local filesystem path in front of a user who
        // cannot act on it, or into a pre-commit hook's output.
        //
        // The working directory in repoRoot's "not a git repository" sentence
        // is the deliberate exception, and it is the shape of the rule rather
        // than a hole in it: the user typed the command in that directory, it
        // is the one thing they have to check, and a message that withheld it
        // would be telling somebody their directory is wrong without saying
        // which one. What the rule is really about is a path this tool knows
        // and the reader does not, in a stack frame or a message they cannot
        // act on.
        process.exitCode = fail(
          err instanceof PolicyError
            ? err.message
            : `conductor: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

  return program;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version already printed what they needed and carry
      // exitCode 0. Everything else is a bad command line, which is the
      // umbrella's "could not carry out what it was asked".
      process.exitCode = err.exitCode === 0 ? 0 : EXIT_COULD_NOT_RUN;
      return;
    }
    // The last backstop. Still one line, still no stack: an unhandled throw
    // printing a stack into a pre-commit hook's output is how a local path
    // ends up pasted into an issue.
    process.exitCode = fail(`conductor: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// realpath both sides before comparing: on macOS the OS temp directory and
// other mount points resolve through a symlink, so import.meta.url reports
// the resolved path while process.argv[1] reports whatever the caller
// typed, and a naive comparison can silently skip main() entirely.
function isMainModule(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
