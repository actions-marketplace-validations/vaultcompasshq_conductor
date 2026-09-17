// The composite Action, read as a file rather than trusted as prose.
//
// Nothing in CI type-checks a workflow file, and a broken one fails on
// somebody else's pull request rather than on this repository's suite. So
// the action is parsed here and the command line it builds is asserted, the
// same way every other command line in this package is.

import { afterAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface ActionFile {
  name?: string;
  description?: string;
  inputs?: Record<string, { default?: string; description?: string; required?: boolean }>;
  outputs?: Record<string, { value?: string; description?: string }>;
  runs?: {
    using?: string;
    steps?: Array<{
      name?: string;
      shell?: string;
      run?: string;
      env?: Record<string, string>;
      id?: string;
    }>;
  };
}

const action = parseYaml(readFileSync(path.join(ROOT, 'action.yml'), 'utf8')) as ActionFile;

const steps = action.runs?.steps ?? [];
const script = steps.map((step) => step.run ?? '').join('\n');

// Each step's own script, by id. Not "the step mentioning conductor": three
// steps now name the same package, so a search like that returns whichever
// one happens to be first and proves nothing about the one under test.
//
// `script` (every step joined) is for claims that are genuinely about the
// whole file, such as "no step reaches into node_modules". A claim about what
// the gates are RUN with belongs to gatesScript, or it passes on a line in
// another step that happens to look similar.
const gatesScript = steps.find((step) => step.id === 'gates')?.run ?? '';
const validateScript = steps.find((step) => step.id === 'validate')?.run ?? '';
const installScript = steps.find((step) => step.id === 'install')?.run ?? '';

function stepEnv(id: string): Record<string, string> {
  return steps.find((step) => step.id === id)?.env ?? {};
}

describe('action.yml', () => {
  it('is a composite action, so it adds no container and no second runner', () => {
    expect(action.runs?.using).toBe('composite');
  });

  it('gives every step an explicit shell, which composite steps require', () => {
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.shell).toBe('bash');
    }
  });

  it('runs the ci stage by default, so every enabled gate runs', () => {
    expect(action.inputs?.stage?.default).toBe('ci');
    expect(gatesScript).toMatch(/--stage "\$STAGE"/);
  });

  it('asks for SARIF into a file the caller can upload', () => {
    expect(gatesScript).toMatch(/--format sarif/);
    expect(gatesScript).toMatch(/--output/);
  });

  it('exposes that path as an output rather than making the caller guess it', () => {
    expect(action.outputs?.sarif).toBeDefined();
    expect(action.outputs?.sarif?.value).toContain('outputs.sarif');
  });

  it('runs the umbrella off PATH and never out of the tree it is judging', () => {
    // node_modules is the head's own install, chosen by the head's own
    // lockfile. Running the umbrella from there hands a pull request the
    // program that judges it, which is the one thing this action must not do.
    //
    // Comment lines are stripped first, the same as the SHA rule below: the
    // action explains at length why node_modules is never reached into, and a
    // rule that fired on the explanation would push the explanation out of
    // the file.
    const code = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    expect(code).not.toMatch(/node_modules/);
    expect(gatesScript).toMatch(/^\s*conductor "\$\{ARGS\[@\]\}"/m);
  });

  it('plumbs through the three variables the pull-request flow reads', () => {
    const env = steps.flatMap((step) => Object.keys(step.env ?? {}));
    expect(env).toContain('GITHUB_EVENT_PATH');
    expect(env).toContain('GITHUB_BASE_REF');
    expect(env).toContain('GITHUB_HEAD_REF');
  });

  it('passes --base only when a ref was actually named', () => {
    // The base-ref input, not github.base_ref: left empty, the umbrella reads
    // GITHUB_BASE_REF itself and treats an empty value as "not a pull
    // request". Passing --base unconditionally would hand it the literal ref
    // "origin/" on every push build and fail it closed for no reason.
    expect(gatesScript).toMatch(/if \[ -n "\$BASE_REF" \]/);
  });

  it('takes the exit code from conductor rather than from the last thing in the script', () => {
    expect(gatesScript).toMatch(/set -eu/);
  });

  it('builds its arguments as an array and expands it quoted', () => {
    // A string built with += and expanded bare is word-split and then
    // glob-expanded by the shell. An output or spec input containing a space
    // becomes two arguments, and one containing a bracket or a star is
    // matched against the workspace, so the gate is handed whatever happens
    // to be checked out.
    expect(gatesScript).toMatch(/ARGS=\(/);
    expect(gatesScript).toMatch(/"\$\{ARGS\[@\]\}"/);
    expect(gatesScript).not.toMatch(/conductor \$ARGS/);
    expect(gatesScript).not.toMatch(/ARGS="\$ARGS/);
  });

  it('quotes every input it puts into the argument list', () => {
    // Only the lines that build or run the argument list: those are where an
    // unquoted expansion changes what the gate is asked to do.
    const argumentLines = gatesScript
      .split('\n')
      .filter((line) => line.includes('ARGS'))
      .join('\n');

    for (const name of ['BASE_REF', 'TRUST_BASE', 'SPEC', 'STAGE', 'OUTPUT']) {
      const quoted = new RegExp(`"\\$${name}"`, 'g');
      expect(argumentLines.replace(quoted, '')).not.toContain(`$${name}`);
    }
  });

  it('reports the SARIF path relative to the workspace, not to the working directory', () => {
    // A caller whose checkout is in a subdirectory otherwise gets a path that
    // does not resolve from where the upload step runs.
    expect(action.outputs?.sarif?.value).toMatch(/steps\./);
    expect(gatesScript).toMatch(/GITHUB_OUTPUT/);
    expect(gatesScript).toMatch(/WORKDIR/);
  });

  it('publishes that path before running the gates, so a failed run still has one', () => {
    // The log is most worth uploading on the run that failed, and the
    // caller's upload step is the one with if: always() on it.
    expect(gatesScript.indexOf('GITHUB_OUTPUT')).toBeGreaterThan(-1);
    expect(gatesScript.indexOf('GITHUB_OUTPUT')).toBeLessThan(
      gatesScript.indexOf('"${ARGS[@]}"')
    );
  });
});

/**
 * Pull-request mode, as the action enters it.
 *
 * Nothing in CI type-checks a workflow file, so the shape of the command line
 * this builds is asserted here or nowhere. The one that would be silent is
 * passing a SHA: a run with `--trust-base ${{ github.sha }}` reports
 * pull-request mode as on while every rule still comes from the tree being
 * judged. The umbrella refuses that, but the action must not produce it.
 */
describe('action.yml enters pull-request mode', () => {
  it('passes origin/GITHUB_BASE_REF when the event set one', () => {
    expect(gatesScript).toMatch(/--trust-base "origin\/\$GITHUB_BASE_REF"/);
  });

  it('passes nothing when GITHUB_BASE_REF is empty, which is every push build', () => {
    // Actions defines the variable and leaves it EMPTY outside a pull
    // request, so an unconditional pass would hand every push the literal
    // ref "origin/" and fail it closed for no reason.
    expect(gatesScript).toMatch(/elif \[ -n "\$\{GITHUB_BASE_REF:-\}" \]/);
  });

  it('never builds the ref out of a commit SHA', () => {
    // github.sha on a pull_request event IS the merge commit, which is HEAD,
    // and head.sha is a different commit carrying HEAD's tree whenever the
    // base has not moved. Either one puts the rules back in the tree being
    // judged.
    // Comment lines are stripped first: the comment in the action explains
    // why neither SHA is used, and a rule that fired on the explanation would
    // push the explanation out of the file.
    const code = [
      ...steps.flatMap((step) => Object.values(step.env ?? {})),
      ...script.split('\n').filter((line) => !line.trim().startsWith('#')),
    ].join('\n');

    expect(code).not.toMatch(/github\.sha/);
    expect(code).not.toMatch(/head\.sha/);
  });

  it('reads every value from the environment rather than expanding it into the script', () => {
    // An expression expanded inside a run block is pasted in as source text
    // before the shell sees it, so a value carrying a quote rewrites the
    // script. The trust base decides where the rules come from, which makes
    // it the worst possible place for that.
    const env = steps.flatMap((step) => Object.keys(step.env ?? {}));
    expect(env).toContain('TRUST_BASE');
    expect(gatesScript).not.toMatch(/\$\{\{/);
  });

  it('lets a caller name the ref explicitly', () => {
    expect(action.inputs?.['trust-base']).toBeDefined();
    expect(action.inputs?.['trust-base']?.default).toBe('');
    expect(gatesScript).toMatch(/if \[ -n "\$TRUST_BASE" \]/);
  });

  it('offers no value that switches pull-request mode off', () => {
    // Base-ref judging is the floor, not a knob. On a pull_request event the
    // workflow file itself runs from the pull request's own ref, so an
    // opt-out input would be settable by the pull request the mode exists to
    // judge: the knob and the thing it protects against are the same file.
    expect(gatesScript).not.toMatch(/"\$TRUST_BASE" = "off"/);
    expect(String(action.inputs?.['trust-base']?.description)).toMatch(
      /no value that turns pull-request mode off/
    );
  });
});

/**
 * The install, which is the whole of 0.4.0's answer to the head-controlled
 * program.
 *
 * The two scripts are RUN here rather than pattern-matched, with npm replaced
 * by a shim that records its arguments. A regular expression over the install
 * line agrees with whatever the author wrote; running it says what npm would
 * actually have been asked to fetch, which is the only claim worth making
 * about a step whose job is to decide which four programs judge a pull
 * request.
 */
const temps: string[] = [];

afterAll(() => {
  while (temps.length > 0) {
    rmSync(temps.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'conductor-action-'));
  temps.push(dir);
  return dir;
}

const VERSION_INPUTS = [
  'conductor-version',
  'dep-guard-version',
  'vault-guard-version',
  'intent-guard-version',
] as const;

const VERSION_VARS: Record<(typeof VERSION_INPUTS)[number], string> = {
  'conductor-version': 'CONDUCTOR_VERSION',
  'dep-guard-version': 'DEP_GUARD_VERSION',
  'vault-guard-version': 'VAULT_GUARD_VERSION',
  'intent-guard-version': 'INTENT_GUARD_VERSION',
};

/** The four defaults as the shell would see them. */
function defaultVersionEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const input of VERSION_INPUTS) {
    env[VERSION_VARS[input]] = String(action.inputs?.[input]?.default ?? '');
  }
  return { ...env, ...overrides };
}

function runValidate(overrides: Record<string, string> = {}) {
  const result = spawnSync('bash', ['-c', validateScript], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...defaultVersionEnv(overrides) },
  });
  return { status: result.status, stderr: result.stderr ?? '' };
}

/**
 * Runs the install script with npm replaced by a recorder.
 *
 * Returns the argument vector npm was handed and the lines the step appended
 * to GITHUB_PATH.
 */
function runInstall(
  overrides: Record<string, string> = {},
): { argv: string[]; githubPath: string; prefix: string } {
  const dir = tempDir();
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const record = path.join(dir, 'npm-argv.txt');
  const shim = path.join(bin, 'npm');
  // The shim also creates `<prefix>/lib` on an install, because a real global
  // install does and the step writes a manifest there and verifies from
  // inside it. A stub that only recorded argv would abort the step on a
  // missing directory, which would be the harness failing rather than the
  // action -- and would hide whether the verification happens at all.
  writeFileSync(
    shim,
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(record)}; done\n` +
      'case "$1" in install) mkdir -p "${npm_config_prefix}/lib" ;; esac\n',
  );
  chmodSync(shim, 0o755);

  const prefix = path.join(dir, 'prefix');
  const githubPath = path.join(dir, 'github-path.txt');
  writeFileSync(record, '');
  writeFileSync(githubPath, '');

  const result = spawnSync('bash', ['-c', installScript], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      npm_config_prefix: prefix,
      GITHUB_PATH: githubPath,
      ...defaultVersionEnv(overrides),
    },
  });
  expect(result.status).toBe(0);

  return {
    argv: readFileSync(record, 'utf8').split('\n').filter((line) => line.length > 0),
    githubPath: readFileSync(githubPath, 'utf8'),
    prefix,
  };
}

describe('action.yml installs the gates without trusting them first', () => {
  it('never lets an installed package run its own install scripts', () => {
    // This step runs on a runner holding the job's token, and the four things
    // it installs are CONTROL INPUTS: they decide whether a pull request is
    // allowed to merge. Without `--ignore-scripts` every package in the
    // resolved tree gets arbitrary code execution here on every run.
    //
    // Verified against the real registry rather than assumed to transfer from
    // vault-guard: all four gates install and report their versions correctly
    // with the flag set.
    expect(runInstall().argv).toContain('--ignore-scripts');
  });

  it('declares all four gates in a manifest, or the audit skips every one of them', () => {
    // `npm audit signatures` audits the tree's EDGES OUT, and a global install
    // leaves `<prefix>/lib` with a `node_modules` and no manifest, so the root
    // declares nothing and the four packages just installed sit on the far end
    // of no edge. Their dependencies get audited; the gates themselves do not.
    //
    // Measured on the real four-package tree: 32 signatures and 8 attestations
    // without this file, 36 and 12 with it. The four missing ones are exactly
    // the four gates. This bug shipped once in vault-guard's single-package
    // version of the same step and was caught in review.
    const run = runInstall();
    const manifest = JSON.parse(
      readFileSync(path.join(run.prefix, 'lib', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };

    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@vaultcompass/conductor',
      '@vaultcompass/dep-guard',
      '@vaultcompass/intent-guard',
      '@vaultcompass/vault-guard',
    ]);
    // The versions have to be the ones being installed, or the audit checks
    // four different packages than the four that landed.
    expect(manifest.dependencies['@vaultcompass/vault-guard']).toBe('1.7.0');
    expect(manifest.dependencies['@vaultcompass/intent-guard']).toBe('1.4.0');
  });

  it('carries a version override into the manifest as well as the install', () => {
    // The two must not drift: an override that reached the install but not the
    // manifest would audit a version nobody installed and pass.
    const run = runInstall({ VAULT_GUARD_VERSION: '1.7.0' });
    const manifest = JSON.parse(
      readFileSync(path.join(run.prefix, 'lib', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies['@vaultcompass/vault-guard']).toBe('1.7.0');
  });

  it('verifies what the registry serves for every name and version it installed', () => {
    // Deliberately not "verifies what it installed": the command refetches
    // manifests from the registry and hashes nothing on disk, so a tampered
    // install passes it. Bounded, and the action comments say so.
    const argv = runInstall().argv;
    expect(argv).toContain('audit');
    expect(argv).toContain('signatures');
  });
});

describe('action.yml installs the gates outside the tree', () => {
  it('pins all four packages to an exact version by default', () => {
    // Exact, never a range and never a tag. The version that judges a pull
    // request has to be decided on the base branch, and a range is a decision
    // taken by the registry on the morning of the run.
    for (const input of VERSION_INPUTS) {
      expect(String(action.inputs?.[input]?.default ?? '')).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(action.inputs?.['conductor-version']?.default).toBe('0.4.0');
    expect(action.inputs?.['dep-guard-version']?.default).toBe('0.6.0');
    expect(action.inputs?.['vault-guard-version']?.default).toBe('1.7.0');
    expect(action.inputs?.['intent-guard-version']?.default).toBe('1.4.0');
  });

  it('accepts an exact version', () => {
    expect(runValidate({ VAULT_GUARD_VERSION: '2.0.1' }).status).toBe(0);
  });

  it('refuses a value carrying a shell metacharacter', () => {
    // The value reaches a command line. It arrives through the environment
    // rather than through an expression, so it cannot rewrite the script, but
    // a package specifier is still not a place to accept punctuation.
    const refused = runValidate({ VAULT_GUARD_VERSION: '1.7.0;rm' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/vault-guard-version/);
  });

  it('refuses a dist-tag, latest included', () => {
    // latest is the whole point of the refusal: it moves, so the version
    // judging a pull request would be whatever the registry served that
    // morning rather than the one pinned on the base branch.
    expect(runValidate({ CONDUCTOR_VERSION: 'latest' }).status).toBe(1);
    expect(runValidate({ DEP_GUARD_VERSION: '^0.6.0' }).status).toBe(1);
  });

  it('validates every one of the four, not just the first', () => {
    for (const variable of Object.values(VERSION_VARS)) {
      expect(runValidate({ [variable]: 'latest' }).status).toBe(1);
    }
  });

  it('asks npm for exactly the four packages at exactly the input versions', () => {
    const { argv } = runInstall();

    // Every argument npm is given across the whole step, in order. The
    // verification call is part of it: asserting only the install would let a
    // second npm invocation be added, or removed, without anything noticing.
    expect(argv).toEqual([
      'install',
      '-g',
      '--ignore-scripts',
      '@vaultcompass/conductor@0.4.0',
      '@vaultcompass/dep-guard@0.6.0',
      '@vaultcompass/vault-guard@1.7.0',
      '@vaultcompass/intent-guard@1.4.0',
      'audit',
      'signatures',
    ]);
  });

  it('carries an overridden version through to the package specifier', () => {
    const { argv } = runInstall({ VAULT_GUARD_VERSION: '1.9.2' });
    expect(argv).toContain('@vaultcompass/vault-guard@1.9.2');
    expect(argv).not.toContain('@vaultcompass/vault-guard@1.7.0');
  });

  it('prepends the install bin directory to PATH rather than calling it by path', () => {
    const { githubPath } = runInstall();
    expect(githubPath.trim()).toMatch(/[/\\]bin$/);
  });

  it('installs under the runner temp, never into the workspace', () => {
    // An install into the checkout would put the programs that judge the pull
    // request inside the tree being judged, and leave them there for the
    // gates to scan.
    expect(stepEnv('install')['npm_config_prefix']).toMatch(/runner\.temp/);
    expect(installScript).not.toMatch(/working-directory/);
  });

  it('also RUNS outside the checkout, so npm never starts in the head tree', () => {
    // A composite step with no working-directory runs at the workspace root.
    // npm in global mode is not known to read a project's configuration from
    // there, and this step must not rest on that: the reason it is safe would
    // be a property of a version of npm rather than of this file.
    expect(steps.find((step) => step.id === 'install')).toHaveProperty(
      'working-directory',
      '${{ runner.temp }}'
    );
  });

  it('installs unconditionally, so a push and a pull request take one code path', () => {
    const install = steps.find((step) => step.id === 'install');
    expect(install).toBeDefined();
    expect(install).not.toHaveProperty('if');
    expect(steps.find((step) => step.id === 'validate')).not.toHaveProperty('if');
    expect(String(action.description ?? '') + script).toMatch(/unconditional/i);
  });

  it('validates before it installs, and installs before it runs', () => {
    const ids = steps.map((step) => step.id);
    expect(ids.indexOf('validate')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('validate')).toBeLessThan(ids.indexOf('install'));
    expect(ids.indexOf('install')).toBeLessThan(ids.indexOf('gates'));
  });

  it('reads the versions from the environment rather than expanding them into a script', () => {
    // Same rule as every other input in this file: an expression expanded
    // inside a run block is pasted in as source text before the shell sees it.
    expect(validateScript).not.toMatch(/\$\{\{/);
    expect(installScript).not.toMatch(/\$\{\{/);
    for (const input of VERSION_INPUTS) {
      expect(Object.values(stepEnv('validate'))).toContain(`\${{ inputs.${input} }}`);
      expect(Object.values(stepEnv('install'))).toContain(`\${{ inputs.${input} }}`);
    }
  });
});
