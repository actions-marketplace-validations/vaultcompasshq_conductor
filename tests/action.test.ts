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
 * The base-ref fetch, run for real against a real (if tiny) git remote.
 *
 * A shallow checkout is what actions/checkout gives a consumer by default
 * (fetch-depth: 1, the head commit alone), so origin/$GITHUB_BASE_REF is
 * simply not in that checkout and conductor's own git reads refuse it as a
 * ref that does not resolve. One real consumer team hit exactly this and
 * worked around it with their own fetch step; this suite runs the gates
 * step's actual script -- not a regex over it -- against a real shallow
 * clone, with `conductor` replaced by a no-op stub and `git` replaced by a
 * pass-through shim that also logs every `fetch` invocation, so "did it
 * fetch" and "did it skip the fetch" are both answered by what git actually
 * did rather than by a pattern match on the YAML.
 */
describe('action.yml shallow-fetches the trust base for a pull-request run', () => {
  function git(args: string[], cwd: string): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${result.stderr ?? result.stdout ?? ''}`);
    }
    return result.stdout ?? '';
  }

  function resolves(ref: string, cwd: string): boolean {
    return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, encoding: 'utf8' })
      .status === 0;
  }

  /**
   * A bare "origin" carrying two branches, "main" (the base) and "feature"
   * (the head, one commit ahead), plus a shallow, single-branch clone of
   * "feature" only. That last part is the actions/checkout default shape on
   * a pull_request event: fetch-depth 1, the head branch alone. origin/main
   * does not resolve in the clone until something fetches it.
   */
  function makeShallowCheckout(): { workdir: string; origin: string } {
    const origin = tempDir();
    git(['init', '--quiet', '--bare', '-b', 'main'], origin);

    const seed = tempDir();
    git(['clone', '--quiet', origin, seed], os.tmpdir());
    git(['config', 'user.email', 'test@example.com'], seed);
    git(['config', 'user.name', 'Test'], seed);
    writeFileSync(path.join(seed, 'file.txt'), 'base\n');
    git(['add', '-A'], seed);
    git(['commit', '--quiet', '-m', 'base'], seed);
    git(['push', '--quiet', 'origin', 'main'], seed);

    git(['checkout', '--quiet', '-b', 'feature'], seed);
    writeFileSync(path.join(seed, 'file.txt'), 'feature\n');
    git(['add', '-A'], seed);
    git(['commit', '--quiet', '-m', 'feature'], seed);
    git(['push', '--quiet', 'origin', 'feature'], seed);

    const workdir = tempDir();
    git(
      ['clone', '--quiet', '--depth', '1', '--branch', 'feature', '--no-tags', origin, workdir],
      os.tmpdir()
    );
    git(['config', 'user.email', 'test@example.com'], workdir);
    git(['config', 'user.name', 'Test'], workdir);

    return { workdir, origin };
  }

  /**
   * Runs the gates step's own script, `conductor` replaced by a stub that
   * exits 0 without reading its arguments (the fetch guard runs before that
   * call, and nothing here is about what conductor does with the result),
   * and `git` replaced by a pass-through shim that also appends every
   * `fetch` invocation's argument line to `fetchLogPath`.
   */
  function runGatesScript(
    workdir: string,
    overrides: Record<string, string> = {}
  ): { status: number; output: string; fetchLog: string[] } {
    const bin = tempDir();
    const conductorShim = path.join(bin, 'conductor');
    writeFileSync(conductorShim, '#!/bin/sh\nexit 0\n');
    chmodSync(conductorShim, 0o755);

    const fetchLogPath = path.join(tempDir(), 'git-fetch-calls.txt');
    writeFileSync(fetchLogPath, '');
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const gitShim = path.join(bin, 'git');
    writeFileSync(
      gitShim,
      `#!/bin/sh\nif [ "$1" = "fetch" ]; then printf '%s\\n' "$*" >> ${JSON.stringify(
        fetchLogPath
      )}; fi\nexec ${JSON.stringify(realGit)} "$@"\n`
    );
    chmodSync(gitShim, 0o755);

    const githubOutput = path.join(tempDir(), 'github-output.txt');
    writeFileSync(githubOutput, '');

    const result = spawnSync('bash', ['-c', gatesScript], {
      cwd: workdir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: githubOutput,
        GITHUB_EVENT_PATH: '',
        GITHUB_BASE_REF: 'main',
        GITHUB_HEAD_REF: 'feature',
        BASE_REF: '',
        TRUST_BASE: '',
        SPEC: '',
        STAGE: 'ci',
        OUTPUT: 'conductor.sarif',
        WORKDIR: '.',
        ...overrides,
      },
    });

    return {
      status: result.status ?? -1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      fetchLog: readFileSync(fetchLogPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0),
    };
  }

  it('fetches origin/<base> when the shallow checkout does not carry it', () => {
    const { workdir } = makeShallowCheckout();
    expect(resolves('origin/main', workdir)).toBe(false);

    const run = runGatesScript(workdir);

    expect(run.status).toBe(0);
    expect(run.fetchLog.length).toBe(1);
    expect(run.fetchLog[0]).toMatch(/--depth=1/);
    expect(run.fetchLog[0]).toMatch(/origin/);
    expect(run.fetchLog[0]).toMatch(/main/);
    // The whole point: after the step runs, the ref conductor is about to be
    // handed as --trust-base actually resolves.
    expect(resolves('origin/main', workdir)).toBe(true);
  });

  it('does not fetch when origin/<base> already resolves in the checkout', () => {
    const { workdir, origin } = makeShallowCheckout();
    // What a deeper fetch-depth, or a prior step, leaves behind: the base
    // branch already in the checkout before this step ever runs. The
    // explicit src:dst refspec is required here for the same reason the
    // step's own fetch needs one: this is a single-branch checkout, so a
    // bare `git fetch origin main` only updates FETCH_HEAD and never
    // creates the origin/main tracking ref this precondition needs.
    git(['fetch', '--quiet', 'origin', 'main:refs/remotes/origin/main'], workdir);
    expect(resolves('origin/main', workdir)).toBe(true);
    void origin;

    const run = runGatesScript(workdir);

    expect(run.status).toBe(0);
    expect(run.fetchLog).toEqual([]);
  });

  it('warns with the exact remedy command rather than hard-failing when the fetch cannot succeed', () => {
    const { workdir } = makeShallowCheckout();
    // A remote that cannot be reached, standing in for no credentials, no
    // network, or a fork pull_request's read-only token: whatever the real
    // cause, the step must not abort over it, and must name the fix.
    git(['remote', 'set-url', 'origin', path.join(workdir, 'no-such-remote')], workdir);

    const run = runGatesScript(workdir);

    // Never a hard failure: the stub conductor still ran and exited 0.
    expect(run.status).toBe(0);
    expect(run.output).toMatch(/::warning::/);
    expect(run.output).toMatch(/git fetch --depth=1 origin main/);
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

/**
 * Runs a validate script, which is the step's own text unless a caller hands
 * over a modified copy.
 *
 * `extraEnv` is how the event is chosen. This harness builds the environment
 * from scratch rather than evaluating the step's `env:` mapping, which it could
 * not do anyway: the mapping holds `${{ }}` expressions that only Actions can
 * resolve. So a harness that wants a pull-request run sets GITHUB_BASE_REF
 * here; left out, the step sees the push shape, which is what every case
 * written before the pull-request rule assumed. On a real runner that variable
 * reaches the step because the step DECLARES it from `github.base_ref`, which
 * the case named after that mapping asserts separately.
 */
function runValidateScript(
  script: string,
  overrides: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
) {
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...defaultVersionEnv(overrides), ...extraEnv },
  });
  return { status: result.status, stderr: result.stderr ?? '' };
}

function runValidate(
  overrides: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
) {
  return runValidateScript(validateScript, overrides, extraEnv);
}

/**
 * Runs the install script with npm replaced by a recorder.
 *
 * Returns the argument vector npm was handed and the lines the step appended
 * to GITHUB_PATH.
 */
function runInstall(
  overrides: Record<string, string> = {},
  npmVersion = '10.9.2',
): { argv: string[]; githubPath: string; prefix: string; status: number; stderr: string } {
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
      // A real npm answers `--version` with a version, and the step now reads
      // it: below 10.5.2 the signature verification calls a clean install
      // tampered with. A stub that printed nothing would make the step refuse,
      // which is correct behaviour against a client it cannot identify but
      // says nothing about the action.
      // `npmVersion` is written verbatim, so a test can hand it MULTIPLE lines
      // and reproduce a client that prints an upgrade notice above its
      // version. That shape defeated two earlier versions of the floor.
      `case "$1" in --version) printf '%b\\n' "${npmVersion}" ;; ` +
      'install) mkdir -p "${npm_config_prefix}/lib" ;; esac\n',
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

  return {
    status: result.status ?? -1,
    // GitHub reads `::error::` annotations from STDOUT, so that is where the
    // step writes them and where a test has to look.
    stderr: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    argv: readFileSync(record, 'utf8').split('\n').filter((line) => line.length > 0),
    githubPath: readFileSync(githubPath, 'utf8'),
    prefix,
  };
}

describe('action.yml installs the gates without trusting them first', () => {
  it('refuses an npm too old to verify signatures, naming the real cause', () => {
    // `npm audit signatures` is not version-stable. Below 10.5.2 it fails on a
    // CLEAN install of these very packages, because the client's bundled keys
    // and TUF root are stale. On 10.5.0 it says "Someone might have tampered
    // with these packages", naming our own; on 10.2.4 it is
    // EEXPIREDSIGNATUREKEY. Both are false and both are alarming.
    //
    // Bisected against a real install of the four gates, on a cold cache and a
    // fresh home: 8.19.4, 9.9.4, 10.2.4, 10.5.0 and 10.5.1 fail; 10.5.2 and
    // later pass. That maps to Node 18.19.x and 20.10 through 20.12, which
    // setup-node will hand a consumer today. This action does not install Node
    // itself -- the documented workflow has the caller do it -- so the floor is
    // enforced rather than assumed.
    // 10.5.1 is the LAST version that fails, and it is what Node 22.0.0 ships.
    //
    // THE 20-DIGIT MAJOR IS NOT FILLER. The floor is shell arithmetic, and
    // `[` refuses an operand that will not fit a machine integer: it writes
    // "out of range" and exits 2, which an `if` reads as false. A
    // refuse-if-bad shape would therefore have taken that as permission to
    // proceed and installed on it. The step is written as accept-only-if
    // instead, so the error leaves NPM_OK at 0 and the step refuses; nothing
    // pinned that restructure until this input, which a mutant with the old
    // shape passed every other assertion in this file while failing.
    for (const old of ['8.19.4', '9.9.4', '10.2.4', '10.5.0', '10.5.1', '99999999999999999999.0.0']) {
      const run = runInstall({}, old);
      expect([old, run.status]).not.toEqual([old, 0]);
      expect(run.stderr).toContain(old);
      expect(run.stderr).toContain('10.5.2 or newer');
      // It must never reach the install with a client that cannot verify.
      expect(run.argv).not.toContain('install');
    }
  });

  it('accepts the first npm that actually verifies, and newer', () => {
    // The floor must not be too high either: refusing a client that verifies
    // fine breaks consumers for nothing.
    // 10.5.2 leads the list deliberately: it is the first version measured to
    // pass on a cold cache, and it is what Node 20.13.0 and 20.13.1 ship. The
    // floor sat at 10.6.0 until a review bisected properly, and that number
    // refused those consumers with a message saying their client could not
    // verify when it could. Both edges of the real boundary are pinned now.
    for (const ok of ['10.5.2', '10.6.0', '10.9.2', '11.0.0', '12.0.0']) {
      expect([ok, runInstall({}, ok).status]).toEqual([ok, 0]);
    }
  });

  it('still sees the version when npm prints a notice above it', () => {
    // The shape that defeated two earlier versions of this floor. A client
    // that prints an upgrade notice first passed the per-line shape check and
    // then failed the arithmetic on the whole string, so the `if` read false
    // and the floor was skipped -- on a client the floor exists to refuse.
    const old = runInstall({}, 'npm notice a new version is available\\n10.5.0');
    expect(old.status).not.toBe(0);
    expect(old.stderr).toContain('10.5.2 or newer');
    expect(old.argv).not.toContain('install');

    // And the same shape must not refuse a client that is fine.
    const current = runInstall({}, 'npm notice a new version is available\\n10.9.2');
    expect(current.status).toBe(0);
    expect(current.argv).toContain('install');
  });

  it('refuses rather than assumes when it cannot read a version at all', () => {
    // A guard that fails open when it cannot see is not a guard. An earlier
    // draft compared the raw string: an unexpected answer made the comparison
    // error, the `if` read false, and every client passed the floor.
    const run = runInstall({}, '');
    expect(run.status).not.toBe(0);
    expect(run.argv).not.toContain('install');
  });

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
    // The NAMES are what matter to the audit: it resolves each edge by name
    // and audits the version that is on disk. A manifest declaring a wrong or
    // even nonexistent version still audits the installed one and exits 0,
    // measured. So these version assertions pin the file against DRIFT from
    // the install; they are not what makes the check cover the right thing.
    // Naming a package that is not installed is the quiet case: the audit
    // skips it and still exits 0.
    expect(manifest.dependencies['@vaultcompass/vault-guard']).toBe('1.8.0');
    expect(manifest.dependencies['@vaultcompass/intent-guard']).toBe('1.5.2');
    expect(manifest.dependencies['@vaultcompass/conductor']).toBe('0.4.5');
    expect(manifest.dependencies['@vaultcompass/dep-guard']).toBe('0.7.0');
  });

  it('carries a version override into the manifest as well as the install', () => {
    // Keeps the manifest honest about what was installed. Not a security
    // property: see above, the audit reads the name and takes the version off
    // disk.
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
    expect(action.inputs?.['conductor-version']?.default).toBe('0.4.5');
    expect(action.inputs?.['dep-guard-version']?.default).toBe('0.7.0');
    expect(action.inputs?.['vault-guard-version']?.default).toBe('1.8.0');
    expect(action.inputs?.['intent-guard-version']?.default).toBe('1.5.2');
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
      // The client-version preflight. Below npm 10.5.2 the verification at the
      // end of this step calls a clean install tampered with, so the step
      // refuses up front and says which npm it found.
      '--version',
      'install',
      '-g',
      '--ignore-scripts',
      '@vaultcompass/conductor@0.4.5',
      '@vaultcompass/dep-guard@0.7.0',
      '@vaultcompass/vault-guard@1.8.0',
      '@vaultcompass/intent-guard@1.5.2',
      'audit',
      'signatures',
    ]);
  });

  it('carries an overridden version through to the package specifier', () => {
    const { argv } = runInstall({ VAULT_GUARD_VERSION: '1.9.2' });
    expect(argv).toContain('@vaultcompass/vault-guard@1.9.2');
    expect(argv).not.toContain('@vaultcompass/vault-guard@1.8.0');
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

  it('declares the pull-request test from the event payload, the same as the gates step', () => {
    // NOT read as the runner's bare default variable. A step-level `env:` entry
    // wins over a job-level one, and `github.base_ref` is resolved from the
    // event payload rather than from anything the workflow author writes, so
    // the obvious bypass -- `env: GITHUB_BASE_REF: ""` at job level, written by
    // the same pull request that writes the pins -- cannot reach this step even
    // if the platform's no-overwrite guarantee for default variables failed.
    // The guarantee is the second line of defence, recorded in
    // docs/INVARIANTS.md and not depended on here.
    expect(stepEnv('validate').GITHUB_BASE_REF).toBe('${{ github.base_ref }}');
    // One spelling across the file: the gates step decides whether to pass
    // `--trust-base` off the same value, and two spellings of one event test
    // are two things to keep in step.
    expect(stepEnv('gates').GITHUB_BASE_REF).toBe(stepEnv('validate').GITHUB_BASE_REF);
  });
});

/**
 * On a pull request, none of the four version inputs may pin BACKWARD.
 *
 * The shape check above asks whether an input is an exact version. It says
 * nothing about WHICH one, and on a same-repo pull_request event GitHub runs
 * the workflow file from the head, so all four of these inputs are written by
 * the pull request being judged.
 */

/** The constant prefix in the validate step that each input is measured against. */
const TAG_CONSTANTS: Record<(typeof VERSION_INPUTS)[number], string> = {
  'conductor-version': 'TAG_CONDUCTOR',
  'dep-guard-version': 'TAG_DEP_GUARD',
  'vault-guard-version': 'TAG_VAULT_GUARD',
  'intent-guard-version': 'TAG_INTENT_GUARD',
};

// The components are READ OUT OF THE STEP rather than written down here. A copy
// in this file would go on agreeing with itself after the action moved, which is
// the one failure a drift guard cannot be allowed to have.
function tagPart(prefix: string, part: 'MAJOR' | 'MINOR' | 'PATCH'): string {
  const name = `${prefix}_${part}`;
  const found = new RegExp(`^\\s*${name}=([0-9]+)$`, 'm').exec(validateScript);
  expect([name, found === null]).toEqual([name, false]);
  return (found as RegExpExecArray)[1];
}

function tagVersion(prefix: string): string {
  return `${tagPart(prefix, 'MAJOR')}.${tagPart(prefix, 'MINOR')}.${tagPart(prefix, 'PATCH')}`;
}

/**
 * One REAL published version of each gate, below what this tag ships.
 *
 * Every one of the four inputs has published versions under its constant, so
 * the shipped step refuses real pins today and these cases can drive the
 * unmodified step text. Counted off the registry on 2026-09-18: 6 conductor
 * below 0.4.0 (0.2.0 through 0.3.0), 8 dep-guard below 0.6.0, 25 vault-guard
 * below 1.7.0, 7 intent-guard below 1.5.2. Forty-six pins in all that a
 * consumer could write today and this tag now refuses on a pull request.
 *
 * Each value here is a version somebody could really have pinned, not a number
 * invented to be low. A raised constant leaves them valid, since they only have
 * to sit BELOW it; a constant lowered under one of them turns these red, which
 * is the right answer for a tag that no longer ships what the table assumes.
 */
const PUBLISHED_BELOW: Record<(typeof VERSION_INPUTS)[number], string> = {
  'conductor-version': '0.3.0',
  'dep-guard-version': '0.5.0',
  'vault-guard-version': '1.6.0',
  'intent-guard-version': '1.4.0',
};

/**
 * The same step with ONE tag constant advanced by a minor version: the action
 * as it will be the day a newer gate ships and this tag starts shipping it.
 *
 * This device exists to prove DRIFT-FORWARD behaviour, that the comparison
 * follows the constant rather than a number frozen into this file, and NOT
 * because the rule is otherwise unobservable: every one of the four inputs has
 * real published versions below its constant (see PUBLISHED_BELOW), and the
 * cases driving the UNMODIFIED step on those versions are in the describe
 * block below.
 *
 * Advancing the constant is not a weakened program: every line of the check is
 * the shipped one, only the number it measures against moves. The replacement
 * is asserted to have MATCHED, so renaming or deleting the constant turns these
 * red rather than quietly re-testing the unmodified step.
 */
function scriptWithFutureTag(prefix: string): string {
  const future = validateScript.replace(
    new RegExp(`^(\\s*)${prefix}_MINOR=([0-9]+)$`, 'm'),
    (_all, indent: string, digits: string) => `${indent}${prefix}_MINOR=${Number(digits) + 1}`,
  );
  expect([prefix, future === validateScript]).toEqual([prefix, false]);
  return future;
}

describe('action.yml refuses a pull request that pins a gate backward', () => {
  it('refuses a version below the one this tag ships, for every one of the four', () => {
    // THE HOLE THIS CLOSES. Once a gate has two published versions, a pull
    // request can pin back to the one that predates the rule that would have
    // caught it, clear the shape check, and be judged by the rule set it chose
    // for itself. The action already refuses to offer an input that turns
    // pull-request mode off, for exactly this reason; the difference is that
    // deleting a control reads as deleting a control, while a version pin reads
    // as ordinary version management.
    for (const input of VERSION_INPUTS) {
      const prefix = TAG_CONSTANTS[input];
      const shipped = tagVersion(prefix);
      const run = runValidateScript(scriptWithFutureTag(prefix), {}, { GITHUB_BASE_REF: 'main' });
      expect([input, run.status]).not.toEqual([input, 0]);
      // The input by name: three other pins are in the same message's reach and
      // a refusal that does not say which one is wrong sends the reader looking.
      expect(run.stderr).toContain(input);
      // BOTH numbers, for the same reason the npm floor names both: what was
      // asked for, and what would have been accepted.
      expect(run.stderr).toContain(shipped);
      expect(run.stderr).toContain('pull request');
      // And the remedy, which is to stop pinning at all.
      expect(run.stderr).toContain('REMOVE the input');
    }
  });

  it('refuses a real published version of every one of the four, on the shipped step', () => {
    // THE UNMODIFIED STEP, on pins a consumer could write this morning. The
    // future-copy cases above prove the comparison follows the constant; these
    // prove the shipped file refuses something real, for all four inputs and
    // not only for intent-guard.
    for (const input of VERSION_INPUTS) {
      const asked = PUBLISHED_BELOW[input];
      const shipped = tagVersion(TAG_CONSTANTS[input]);
      const run = runValidate({ [VERSION_VARS[input]]: asked }, { GITHUB_BASE_REF: 'main' });
      expect([input, asked, run.status]).toEqual([input, asked, 1]);
      // The input by name, since three other pins are in the same message's
      // reach and a refusal that does not say which one sends the reader
      // looking.
      expect(run.stderr).toContain(input);
      // BOTH numbers: what was asked for, and what would have been accepted.
      expect(run.stderr).toContain(asked);
      expect(run.stderr).toContain(shipped);
      expect(run.stderr).toContain('REMOVE the input');
      // And only on a pull request. The same published pin is accepted with
      // GITHUB_BASE_REF unset, which is the SCOPE of the rule rather than a
      // claim that a push run is safe.
      const push = runValidate({ [VERSION_VARS[input]]: asked }, {});
      expect([input, asked, push.status]).toEqual([input, asked, 0]);
    }
  });

  it('checks each input against its own constant, not against one shared number', () => {
    // Advancing ONE constant must refuse ONE input. A single constant serving
    // all four, or a loop that reads the wrong pair, would name the others too.
    const run = runValidateScript(
      scriptWithFutureTag('TAG_VAULT_GUARD'),
      {},
      { GITHUB_BASE_REF: 'main' },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('vault-guard-version');
    expect(run.stderr).not.toContain('conductor-version');
    expect(run.stderr).not.toContain('dep-guard-version');
    expect(run.stderr).not.toContain('intent-guard-version');
  });

  it('reports every backward pin before exiting, like the shape check above it', () => {
    // Two bad pins should not need two runs to learn about.
    const run = runValidate(
      { INTENT_GUARD_VERSION: '1.4.0', VAULT_GUARD_VERSION: '1.6.0' },
      { GITHUB_BASE_REF: 'main' },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('intent-guard-version');
    expect(run.stderr).toContain('vault-guard-version');
  });

  it('refuses the intent-guard version that shipped before this tag', () => {
    // Not hypothetical, and not reached through a modified copy: 1.4.0 is the
    // default this tag replaces, it is published, and a pull request asking for
    // it is asking to be judged by the gate that refuses `--paths ""`.
    const run = runValidate({ INTENT_GUARD_VERSION: '1.4.0' }, { GITHUB_BASE_REF: 'main' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('1.4.0');
    expect(run.stderr).toContain('1.5.2');
  });

  it('refuses a same-minor pin with a lower patch than the tag ships', () => {
    // pin_not_backward's third arm: pin_major == tag_major, pin_minor ==
    // tag_minor, and pin_patch below tag_patch. Every case above this one
    // drives the major or minor comparison; intent-guard is the only one of
    // the four whose tag constant (TAG_INTENT_GUARD) has a non-zero patch
    // today, 1.5.2, so it is the only input that can reach this arm at all.
    const run = runValidate({ INTENT_GUARD_VERSION: '1.5.1' }, { GITHUB_BASE_REF: 'main' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('1.5.1');
    expect(run.stderr).toContain(tagVersion(TAG_CONSTANTS['intent-guard-version']));
  });

  it('leaves push runs alone, where GITHUB_BASE_REF is not set', () => {
    // The event test is GITHUB_BASE_REF being non-empty, which is exactly how
    // the run step decides to pass `--trust-base`. With it unset the same low
    // pins are accepted. That is SCOPE, not a safety argument: a push to an
    // unprotected branch runs that branch's own workflow file, written by the
    // same author, and this rule does not cover it.
    for (const input of VERSION_INPUTS) {
      const push = runValidateScript(scriptWithFutureTag(TAG_CONSTANTS[input]), {}, {});
      expect([input, push.status]).toEqual([input, 0]);
    }
    expect(runValidate({ INTENT_GUARD_VERSION: '1.4.0' }, {}).status).toBe(0);
    // An empty value is what Actions itself sets outside a pull request, and it
    // has to read the same as unset or every push build goes red.
    expect(runValidate({ INTENT_GUARD_VERSION: '1.4.0' }, { GITHUB_BASE_REF: '' }).status).toBe(0);
  });

  it('accepts the four versions this tag actually ships, on a pull request', () => {
    // Against the REAL step, not a future copy: the shipped defaults have to
    // pass on a pull-request run, or every consumer's pull request goes red the
    // day this lands.
    expect(runValidate({}, { GITHUB_BASE_REF: 'main' }).status).toBe(0);
    for (const input of VERSION_INPUTS) {
      const explicit = { [VERSION_VARS[input]]: tagVersion(TAG_CONSTANTS[input]) };
      expect([input, runValidate(explicit, { GITHUB_BASE_REF: 'main' }).status]).toEqual([input, 0]);
    }
  });

  it('allows pinning forward on a pull request, and orders numerically', () => {
    // Pinning FORWARD stays allowed, on an assumption this rule does not
    // enforce: that a newer gate is at least as strict. Forward pins are not
    // bounded.
    //
    // The `.10.` values are the ones a lexicographic comparison gets wrong:
    // `1.10.0` sorts BELOW `1.5.2` as text and above it as a version, and
    // refusing it would refuse the very direction this rule leaves open.
    const forward: Array<[string, string]> = [
      ['INTENT_GUARD_VERSION', '1.5.3'],
      ['INTENT_GUARD_VERSION', '1.6.0'],
      ['INTENT_GUARD_VERSION', '1.10.0'],
      ['INTENT_GUARD_VERSION', '2.0.0'],
      ['INTENT_GUARD_VERSION', '10.0.0'],
      ['DEP_GUARD_VERSION', '0.7.1'],
      ['DEP_GUARD_VERSION', '0.10.0'],
      ['VAULT_GUARD_VERSION', '1.8.1'],
      ['VAULT_GUARD_VERSION', '1.10.0'],
      ['CONDUCTOR_VERSION', '0.4.6'],
      ['CONDUCTOR_VERSION', '0.10.0'],
    ];
    for (const [variable, value] of forward) {
      const run = runValidate({ [variable]: value }, { GITHUB_BASE_REF: 'main' });
      expect([variable, value, run.status]).toEqual([variable, value, 0]);
    }
  });

  it('lets the shape check answer first for a value that is not a version', () => {
    // Two checks, deliberately, and the order decides which message a reader
    // gets. `latest` is not a backward pin, it is not a version at all, and the
    // useful answer says so rather than lecturing about pull requests.
    const run = runValidate({ INTENT_GUARD_VERSION: 'latest' }, { GITHUB_BASE_REF: 'main' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/must be an exact version/);
    expect(run.stderr).not.toContain('REMOVE the input');
  });

  it('keeps each tag constant and its input default one number', () => {
    // THE DRIFT GUARD, and the most important case here. The constant the rule
    // measures against and the default the action ships have to say the same
    // thing. Let them drift and the rule measures against a version this tag
    // does not install: a constant left BEHIND the default goes on admitting
    // the pin it exists to refuse, and does it quietly.
    for (const input of VERSION_INPUTS) {
      expect([input, tagVersion(TAG_CONSTANTS[input])]).toEqual([
        input,
        String(action.inputs?.[input]?.default ?? ''),
      ]);
    }
  });

  it('writes the check accept-only-if, gated on the event, after the shape check', () => {
    // Stated as text because behaviour cannot see a check that is not there,
    // and because the FAILURE DIRECTION is the point. `[` exits 2 on a
    // malformed comparison and an `if` reads 2 as false, so a refuse-if shape
    // turns an arithmetic error into permission, on the one check whose whole
    // job is to refuse. The flag therefore starts at 0 and is only raised by a
    // comparison that succeeded.
    //
    // Comment lines are stripped first, the same as every other text rule in
    // this file: the step explains this at length, and a rule that fired on the
    // explanation would push the explanation out of the file.
    const code = validateScript
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const shapeAt = code.indexOf('SEMVER=');
    const initAt = code.indexOf('pin_ok=0');
    const raiseAt = code.indexOf('pin_ok=1');
    const verdictAt = code.indexOf('"$pin_ok" -eq 1');
    const gateAt = code.indexOf('-n "${GITHUB_BASE_REF:-}"');
    const callAt = code.indexOf('check_pin conductor-version');
    const exitAt = code.indexOf('"$pin_status" -ne 0');
    expect([shapeAt, initAt, raiseAt, verdictAt, gateAt, callAt, exitAt].every((at) => at !== -1))
      .toBe(true);
    // The flag starts at 0, is only ever raised by a comparison that succeeded,
    // and is read last. An error on the way leaves it at 0 and the step
    // refuses.
    expect(raiseAt).toBeGreaterThan(initAt);
    expect(verdictAt).toBeGreaterThan(raiseAt);
    // And the whole thing runs on one event only, after the shape check. No
    // call is reachable before the gate: a check_pin above it would fire on
    // every push build.
    expect(gateAt).toBeGreaterThan(shapeAt);
    expect(callAt).toBeGreaterThan(gateAt);
    expect(exitAt).toBeGreaterThan(callAt);
    expect(code.slice(0, gateAt)).not.toMatch(/^\s*check_pin /m);
    // Compared component by component, never as text.
    expect(code).not.toMatch(/"\$pin_value" *[<>]/);
  });
});

/**
 * The shape check refuses a leading zero on any of the three components.
 *
 * npm's specifier parser reads `01.2.3` and `0.6.00` as something it cannot
 * parse as a version at all, and falls back to reading them as a DIST-TAG,
 * which hands the registry the choice this check exists to take away from
 * it. A charset of three plain `[0-9]+` groups lets every one of those
 * through; the sibling scanners vault-guard and dep-guard both refuse them
 * with `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`, and conductor's
 * own shape check has to match, since it feeds these same four inputs
 * straight into `npm install -g @vaultcompass/...@<version>`.
 *
 * The shape check runs before the event test, so it refuses a leading zero
 * on a push build as readily as on a pull request; none of these cases sets
 * GITHUB_BASE_REF.
 */
describe('action.yml refuses a leading zero in any of the four version inputs', () => {
  it('refuses a leading zero on the first component, for every one of the four', () => {
    for (const input of VERSION_INPUTS) {
      const run = runValidate({ [VERSION_VARS[input]]: '01.2.3' });
      expect([input, run.status]).not.toEqual([input, 0]);
      expect(run.stderr).toContain(input);
      expect(run.stderr).toContain('01.2.3');
      expect(run.stderr).toMatch(/leading zero/);
    }
  });

  it('refuses a leading zero on the minor or patch component too', () => {
    for (const value of ['0.06.0', '0.6.00']) {
      const run = runValidate({ INTENT_GUARD_VERSION: value });
      expect([value, run.status]).not.toEqual([value, 0]);
      expect(run.stderr).toMatch(/leading zero/);
    }
  });

  it('still accepts a component that is a genuine single zero, like the shipped defaults', () => {
    // The fix must refuse a leading zero on a multi-digit component without
    // refusing a lone zero digit: 0.4.0, 0.7.0 and 1.5.2-shaped versions all
    // carry one or more single-zero components and have to keep passing.
    for (const input of VERSION_INPUTS) {
      const shipped = String(action.inputs?.[input]?.default ?? '');
      expect([input, shipped, runValidate({ [VERSION_VARS[input]]: shipped }).status]).toEqual([
        input,
        shipped,
        0,
      ]);
    }
    expect(runValidate({ INTENT_GUARD_VERSION: '10.20.30' }).status).toBe(0);
  });
});
