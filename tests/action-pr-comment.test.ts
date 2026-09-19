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
import { readFileSync } from 'node:fs';
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

describe('README documents the pr-comment input', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  it('names the input, the required permission, and the fork no-op', () => {
    expect(readme).toMatch(/pr-comment/);
    expect(readme).toMatch(/pull-requests:\s*write/);
    expect(readme.toLowerCase()).toMatch(/fork/);
  });
});
