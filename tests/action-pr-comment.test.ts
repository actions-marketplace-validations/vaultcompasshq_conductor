// The opt-in, fork-safe pull-request-comment surface on the composite
// Action: a `pr-comment` input, off by default, that -- only on a
// pull_request/pull_request_target event -- posts conductor's own text
// report as a sticky pull request comment.
//
// Sibling to tests/action.test.ts, which already owns the gates/install/
// validate steps; this file owns the one new step and the one new input,
// using the same device that file does: action.yml is parsed and the
// composite step's own script is asserted on and driven, never trusted as
// prose, because nothing in CI type-checks a workflow file.

import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface ActionFile {
  inputs?: Record<string, { default?: string; description?: string; required?: boolean }>;
  runs?: {
    steps?: Array<{
      name?: string;
      id?: string;
      shell?: string;
      if?: string;
      run?: string;
      env?: Record<string, string>;
      'working-directory'?: string;
    }>;
  };
}

const actionYmlText = readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
const action = parseYaml(actionYmlText) as ActionFile;
const steps = action.runs?.steps ?? [];
const prCommentStep = steps.find((step) => step.id === 'pr-comment');
const prCommentScript = prCommentStep?.run ?? '';

function stepEnv(id: string): Record<string, string> {
  return steps.find((step) => step.id === id)?.env ?? {};
}

/**
 * Runs the real `pr-comment` step script under bash, with `node` and
 * `conductor` replaced by recording/no-op shims on PATH, so the WIRING
 * (which env vars the step reads, which flags it passes on) is proven by
 * actually executing the script rather than by pattern-matching its text.
 *
 * `mktempFails: true` swaps in a `mktemp` shim that always exits 1, for the
 * "the temp file could not be created" case: the fail-safe guard around
 * `REPORT_FILE="$(mktemp)"` has to be proven by making mktemp actually fail,
 * not by reading the script and trusting the guard is reachable.
 */
function runPrCommentScript(
  extraEnv: Record<string, string>,
  { mktempFails = false }: { mktempFails?: boolean } = {},
): { status: number | null; stdout: string; stderr: string; nodeArgv: string[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'conductor-pr-comment-step-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const record = path.join(dir, 'node-argv.jsonl');
    writeFileSync(record, '');

    // Records the argv `node` was invoked with, one argument per line
    // (there is only one `node` call in the script, so the whole file is
    // that one call's argv), and exits 0 -- standing in for the real
    // scripts/pr-comment.mjs, which never exits non-zero by its own
    // contract. A plain POSIX shell script, deliberately: naming it `node`
    // and having it shell out to the real `node` to do the recording would
    // resolve through this same overridden PATH and shim itself.
    const nodeShim = path.join(bin, 'node');
    writeFileSync(
      nodeShim,
      '#!/bin/sh\n' +
        'for arg in "$@"; do\n' +
        `  printf '%s\\n' "$arg" >> ${JSON.stringify(record)}\n` +
        'done\n' +
        'exit 0\n',
    );
    chmodSync(nodeShim, 0o755);

    // A no-op stand-in for the real conductor CLI, so the second gates run
    // this step performs succeeds without needing a real scan.
    const conductorShim = path.join(bin, 'conductor');
    writeFileSync(conductorShim, '#!/bin/sh\nexit 0\n');
    chmodSync(conductorShim, 0o755);

    if (mktempFails) {
      const mktempShim = path.join(bin, 'mktemp');
      writeFileSync(mktempShim, '#!/bin/sh\nexit 1\n');
      chmodSync(mktempShim, 0o755);
    }

    const result = spawnSync('bash', ['-c', prCommentScript], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        STAGE: 'ci',
        BASE_REF: '',
        TRUST_BASE: '',
        SPEC: '',
        GITHUB_BASE_REF: '',
        ACTION_PATH: '/action',
        PR_NUMBER: '42',
        GITHUB_REPOSITORY: 'acme/widgets',
        PR_COMMENT_MARKER: '',
        ...extraEnv,
      },
    });

    const nodeArgv = readFileSync(record, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);

    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      nodeArgv,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('action.yml: pr-comment input', () => {
  it('exists, defaults to "false", so an existing consumer is unaffected', () => {
    expect(action.inputs?.['pr-comment']).toBeDefined();
    expect(action.inputs?.['pr-comment']?.default).toBe('false');
  });

  it('documents that it needs pull-requests: write, is opt-in, and no-ops on a fork', () => {
    const description = String(action.inputs?.['pr-comment']?.description ?? '');
    expect(description).toMatch(/pull-requests:\s*write/);
    expect(description.toLowerCase()).toMatch(/fork/);
    // "off by default" / "on" wording, whatever it says exactly, has to be
    // present so a reader does not have to infer opt-in from the default
    // alone.
    expect(description.toLowerCase()).toMatch(/default/);
  });
});

describe('action.yml: the pr-comment step', () => {
  it('exists, runs after the gates step, and declares bash explicitly', () => {
    expect(prCommentStep).toBeDefined();
    expect(prCommentStep?.shell).toBe('bash');
    const ids = steps.map((step) => step.id);
    expect(ids.indexOf('gates')).toBeLessThan(ids.indexOf('pr-comment'));
  });

  it('only runs when pr-comment is exactly "true"', () => {
    expect(String(prCommentStep?.if ?? '')).toMatch(/inputs\.pr-comment == 'true'/);
  });

  it('only runs on a pull_request or pull_request_target event', () => {
    const condition = String(prCommentStep?.if ?? '');
    expect(condition).toMatch(/github\.event_name == 'pull_request'/);
    expect(condition).toMatch(/github\.event_name == 'pull_request_target'/);
  });

  it('runs even when the gates step already failed, so a blocking run still gets a comment', () => {
    // Composite-action steps stop after a failing prior step unless a later
    // one opts back in with always(). This is what the gates step's exit
    // code being "the pull request's advisory report" -- not "whether a
    // developer gets to see it" -- actually rests on.
    expect(String(prCommentStep?.if ?? '')).toMatch(/always\(\)/);
  });

  it('reads the four report-shaping inputs from the environment, not by expanding them into the script', () => {
    // Same rule as every other input in this file: an expression expanded
    // inside a run block is pasted in as source text before the shell sees
    // it.
    expect(prCommentScript).not.toMatch(/\$\{\{/);
    const env = stepEnv('pr-comment');
    expect(env.STAGE).toBe('${{ inputs.stage }}');
    expect(env.BASE_REF).toBe('${{ inputs.base-ref }}');
    expect(env.TRUST_BASE).toBe('${{ inputs.trust-base }}');
    expect(env.SPEC).toBe('${{ inputs.spec }}');
  });

  it('mirrors the gates step\'s own pull-request-mode derivation exactly', () => {
    // "Mirror whatever you gave the Action", the same rule the README's
    // manual recipe already states: a comment step that derived trust-base
    // differently from the gates step would report a different contract from
    // the one the SARIF log used.
    const gatesScript = steps.find((step) => step.id === 'gates')?.run ?? '';
    for (const line of [
      'if [ -n "$BASE_REF" ]',
      'if [ -n "$TRUST_BASE" ]',
      'elif [ -n "${GITHUB_BASE_REF:-}" ]',
      '--trust-base "origin/$GITHUB_BASE_REF"',
      'if [ -n "$SPEC" ]',
    ]) {
      expect(gatesScript).toContain(line);
      expect(prCommentScript).toContain(line);
    }
  });

  it('asks conductor for the TEXT report, verbose, reusing the format the README documents', () => {
    expect(prCommentScript).toMatch(/--format text/);
    expect(prCommentScript).toMatch(/--verbose/);
  });

  it('pins the compact-on-refusal flag to the pr-comment step alone, spelled exactly', () => {
    // The spelling matters: --compact-on-refresh is not a flag conductor
    // understands, and a typo here would silently fall through to the full
    // per-gate report on every refusal instead of erroring loudly.
    expect(prCommentScript).not.toMatch(/--compact-on-refresh\b/);
    expect(prCommentScript).toMatch(/--compact-on-refusal\b/);

    // The gates step still gets the FULL report: its own text or SARIF
    // output is what a developer without pr-comment enabled reads, and
    // shrinking that would swallow the only report of a refusal some
    // adopters ever see.
    const gatesScript = steps.find((step) => step.id === 'gates')?.run ?? '';
    expect(gatesScript).not.toMatch(/--compact-on-refusal\b/);
  });

  it('never fails the job on a blocking verdict: the gates step alone owns that exit code', () => {
    expect(prCommentScript).toMatch(/conductor "\$\{ARGS\[@\]\}" \|\| true/);
  });

  it('invokes the bundled script by github.action_path, never by a path inside the checkout', () => {
    // The consumer's own tree is what this action scans; its script lives in
    // THIS action's own tree instead, which github.action_path names
    // regardless of where the caller checked out.
    expect(stepEnv('pr-comment').ACTION_PATH).toBe('${{ github.action_path }}');
    expect(prCommentScript).toMatch(/node "\$ACTION_PATH\/scripts\/pr-comment\.mjs"/);
  });

  it('passes the report by file path, never by interpolating its content into the command', () => {
    expect(prCommentScript).toMatch(/--report "\$REPORT_FILE"/);
    // No `cat`, `$(<file)`, or similar substitution feeding the report's
    // bytes back into a shell command.
    expect(prCommentScript).not.toMatch(/cat "\$REPORT_FILE"/);
    expect(prCommentScript).not.toMatch(/\$\(<\s*"\$REPORT_FILE"\)/);
  });

  it('passes the pull request number and repository the node script needs', () => {
    expect(prCommentScript).toMatch(/--pr "\$PR_NUMBER"/);
    expect(prCommentScript).toMatch(/--repo "\$GITHUB_REPOSITORY"/);
    expect(stepEnv('pr-comment').PR_NUMBER).toBe('${{ github.event.pull_request.number }}');
    expect(stepEnv('pr-comment').GITHUB_REPOSITORY).toBe('${{ github.repository }}');
  });

  it('gives gh a write-capable token by declaring GH_TOKEN from github.token', () => {
    expect(stepEnv('pr-comment').GH_TOKEN).toBe('${{ github.token }}');
  });
});

describe('action.yml: pr-comment-marker input', () => {
  it('exists and defaults to empty, so an existing consumer sees no behaviour change', () => {
    expect(action.inputs?.['pr-comment-marker']).toBeDefined();
    expect(action.inputs?.['pr-comment-marker']?.default).toBe('');
  });

  it('is read into the pr-comment step as PR_COMMENT_MARKER, not expanded into the script', () => {
    expect(stepEnv('pr-comment').PR_COMMENT_MARKER).toBe('${{ inputs.pr-comment-marker }}');
    expect(prCommentScript).not.toMatch(/\$\{\{\s*inputs\.pr-comment-marker/);
  });

  it('flows through to the CLI as --marker when the input is set, proven by actually running the step', () => {
    // Two runs of the real step's own bash script rather than assertions
    // about its text: this is what proves the input reaches the CLI's argv
    // rather than sitting in an env var nothing reads.
    const withMarker = runPrCommentScript({ PR_COMMENT_MARKER: 'conductor-report: subdir-a' });
    expect(withMarker.status).toBe(0);
    const markerIndex = withMarker.nodeArgv.indexOf('--marker');
    expect(markerIndex).toBeGreaterThan(-1);
    expect(withMarker.nodeArgv[markerIndex + 1]).toBe('conductor-report: subdir-a');
  });

  it('adds no --marker flag when the input is left empty, so the CLI keeps its own built-in default', () => {
    const withoutMarker = runPrCommentScript({ PR_COMMENT_MARKER: '' });
    expect(withoutMarker.status).toBe(0);
    expect(withoutMarker.nodeArgv).not.toContain('--marker');
  });
});

describe('action.yml: the pr-comment step is fail-safe around mktemp', () => {
  it('warns and exits 0, never failing the job, when the temp file cannot be created', () => {
    // REPORT_FILE="$(mktemp)" runs under `set -eu` before any `|| true` in
    // this step. Left unguarded, a mktemp failure aborts the whole step
    // non-zero -- and since the gates step above may already have passed,
    // that would flip an otherwise-passing job to failed over a step that
    // exists purely to post an advisory comment. Proven by making mktemp
    // actually fail, not by reading the guard and trusting it is reachable.
    const result = runPrCommentScript({}, { mktempFails: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/::warning::/);
    expect(result.stdout.toLowerCase()).toMatch(/temporary file|mktemp/);
    // The gates verdict is independent of this step either way, but a
    // mktemp failure should also mean the comment step never reaches the
    // point of invoking node at all.
    expect(result.nodeArgv).toEqual([]);
  });
});

describe('README documents the pr-comment input', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  it('names the input, the required permission, and the fork no-op', () => {
    expect(readme).toMatch(/pr-comment/);
    expect(readme).toMatch(/pull-requests:\s*write/);
    expect(readme.toLowerCase()).toMatch(/fork/);
  });
});
