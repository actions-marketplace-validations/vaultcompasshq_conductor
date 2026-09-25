// The end-to-end test: a real clone, the real three gates, a real commit.
//
// Everything else in this suite proves one piece against a fixture. This
// proves the pieces compose, which is the only place a cross-piece
// disagreement can show up: a policy file init wrote, parsed by the loader,
// resolved to binaries, run as children, normalized, reported, composed
// into an exit code, and acted on by a hook git actually invoked.
//
// It skips rather than fails when the sibling checkouts are not present, so
// a clone of this repository alone still has a green suite. When it skips,
// nothing in this file has been proven, and the skip message says which
// piece was missing rather than reading as a pass.

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NATIVE_CONTRACT_PATHS } from '../src/intent-prepare.js';
import { atLeastVersion } from '../src/trust-base.js';
import { childEnv, shimGit } from './helpers/child-env.js';

const CONDUCTOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONDUCTOR_CLI = path.join(CONDUCTOR_ROOT, 'dist', 'cli.js');

// Sibling checkouts, resolved relative to this repository rather than from
// an absolute path, so no machine layout is written down here.
const SIBLINGS = path.resolve(CONDUCTOR_ROOT, '..');
const DEP_GUARD_REPO = path.join(SIBLINGS, 'dep-guard');
const DEP_GUARD_CLI = path.join(DEP_GUARD_REPO, 'packages', 'cli', 'dist', 'cli.js');
const DEP_GUARD_CORPUS = path.join(DEP_GUARD_REPO, '.corpus-work', 'corpus');
/**
 * The small committed corpus, for the composed test.
 *
 * The locally BUILT corpus above is whatever this machine last downloaded, so
 * whether a given name is known to it is a fact about a download rather than
 * about the fixture. The committed one is 53 names and is the same on every
 * machine, which is what lets the composed test say "a name the corpus does
 * not know" and mean it.
 */
const DEP_GUARD_FIXTURE_CORPUS = path.join(
  DEP_GUARD_REPO,
  'packages',
  'core',
  'fixtures',
  'corpus'
);
const INTENT_GUARD_CLI = path.join(
  SIBLINGS,
  'intent-guard',
  'packages',
  'cli',
  'dist',
  'intent-guard.js'
);
function vaultGuardOnPath(): string | null {
  const found = spawnSync('sh', ['-c', 'command -v vault-guard'], { encoding: 'utf8' });
  const value = (found.stdout ?? '').trim();
  return found.status === 0 && value.length > 0 ? value : null;
}

const VAULT_GUARD = vaultGuardOnPath();

/**
 * A vault-guard BUILD to drive through the policy's absolute `command:`, for
 * the pull-request-mode case that needs a known version rather than whatever
 * this machine installed.
 *
 * An environment variable first, then a sibling checkout, and nothing
 * hardcoded. The build under test may not be a sibling of this repository at
 * all, and a machine layout has no business in a tracked file: this
 * repository's own lint refuses one. When neither is there the case skips
 * with a message naming what was missing, exactly like the rest of this file,
 * and a skip is not a pass.
 */
const VAULT_GUARD_CLI =
  process.env.CONDUCTOR_VAULT_GUARD_CLI ??
  path.join(SIBLINGS, 'vault-guard', 'packages', 'cli', 'dist', 'cli-entry.js');

const missing = [
  existsSync(CONDUCTOR_CLI) ? null : 'the umbrella is not built (run pnpm build)',
  existsSync(DEP_GUARD_REPO) ? null : 'no dep-guard checkout beside this repository',
  existsSync(DEP_GUARD_CLI) ? null : 'dep-guard is not built',
  existsSync(DEP_GUARD_CORPUS) ? null : 'dep-guard has no locally built corpus',
  existsSync(INTENT_GUARD_CLI) ? null : 'no intent-guard build beside this repository',
  VAULT_GUARD === null ? 'no vault-guard on PATH' : null,
].filter((entry): entry is string => entry !== null);

const describeE2E = missing.length === 0 ? describe : describe.skip;

/**
 * The contract the sibling intent-guard just froze, under whichever of its
 * two state-directory names that build uses.
 *
 * This suite runs against WHATEVER intent-guard is checked out beside this
 * repository, which is the whole point of it, so it cannot assume a version.
 * 1.3.0 renamed the directory from `.conductor` to `.intent-guard`; a
 * checkout on either side of that rename has to leave this suite green, or
 * the suite stops being evidence about the umbrella and starts being a
 * reading of the sibling's version number. Canonical first, matching the
 * order the umbrella itself uses. Throwing names both, because "no such
 * file" on one guessed path is the least useful way to learn this.
 */
function frozenContractIn(projectRoot: string): string {
  // The pair comes from the source rather than being spelled again here, so
  // "every consumer reads NATIVE_CONTRACT_PATHS" stays a fact about the
  // repository rather than a claim in a document.
  const candidates = NATIVE_CONTRACT_PATHS.map((relative) => path.join(projectRoot, relative));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `intent-guard froze no contract this suite can find. Looked for: ${candidates.join(', ')}`
    );
  }
  return found;
}

// The scratch parent is overridable so a session can point it at its own
// scratch area; the default is the OS temp directory, never anywhere near
// the checkouts being read.
const SCRATCH_PARENT = process.env.CONDUCTOR_SCRATCH_DIR ?? os.tmpdir();

let clone = '';
let binDir = '';
let env: NodeJS.ProcessEnv = {};

function shim(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function git(args: string[], options: { cwd?: string } = {}): string {
  return execFileSync('git', args, {
    cwd: options.cwd ?? clone,
    encoding: 'utf8',
  });
}

function conductor(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CONDUCTOR_CLI, ...args], {
    cwd: clone,
    encoding: 'utf8',
    env,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describeE2E('dogfood: a real clone, the real gates, a real commit', () => {
  beforeAll(() => {
    mkdirSync(SCRATCH_PARENT, { recursive: true });
    const scratch = mkdtempSync(path.join(SCRATCH_PARENT, 'conductor-dogfood-'));
    clone = path.join(scratch, 'clone');
    binDir = path.join(scratch, 'bin');

    // A real clone of a real guard repository. Untracked things (its
    // node_modules, its corpus) do not come along, which is what makes the
    // clone a fair test of resolution.
    // No --depth: git ignores it for a local clone and warns about it, and
    // a warning in a test log is a thing people learn to skip past.
    execFileSync('git', ['clone', '--quiet', DEP_GUARD_REPO, clone]);
    git(['config', 'user.email', 'dogfood@example.com']);
    git(['config', 'user.name', 'Dogfood']);

    // The guard repositories now run the umbrella over themselves, so the
    // one cloned here tracks its own .guardrails.yaml. This suite is the
    // FRESH ADOPTION case: it asserts what init writes into a repository
    // that has none, and init deliberately never rewrites a policy file it
    // finds. Without this the clone arrives with the sibling's committed
    // policy, the assertion about what init enabled reads that file instead
    // of one init wrote, and the revert tests then run against a manifest
    // that never recorded a policy file at all.
    //
    // Removed by commit rather than by deleting the file, so the clone is a
    // clean tree and the later tests can stage and revert against it. The
    // existence check is for the day the sibling stops tracking one: nothing
    // to remove is the state this wants, not a reason to fail in beforeAll.
    if (existsSync(path.join(clone, '.guardrails.yaml'))) {
      git(['rm', '--quiet', '.guardrails.yaml']);
      git(['commit', '--quiet', '-m', 'dogfood fixture: start from no policy file']);
    }

    shim(binDir, 'conductor', `#!/bin/sh\nexec ${process.execPath} ${CONDUCTOR_CLI} "$@"\n`);
    shim(binDir, 'dep-guard', `#!/bin/sh\nexec ${process.execPath} ${DEP_GUARD_CLI} "$@"\n`);
    shim(binDir, 'vault-guard', `#!/bin/sh\nexec ${VAULT_GUARD as string} "$@"\n`);
    // intent-guard is deliberately NOT shimmed. It is the unpublished one,
    // and reaching it through the policy file's absolute "command:" is the
    // case that override exists for.

    // node and git are SHIMMED here rather than reached by putting their own
    // directories on PATH, and that is the whole point of the arrangement
    // below. See the PATH comment.
    shim(binDir, 'node', `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    const gitBinary = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    shim(binDir, 'git', `#!/bin/sh\nexec ${gitBinary} "$@"\n`);

    // CONSTRUCTED, never inherited, and it is exactly one directory: the one
    // this test filled itself.
    //
    // Prepending to the developer's own PATH made this suite's verdict
    // depend on that developer's machine. The assertion below that init
    // leaves the intent gate off is a claim that intent-guard is not
    // findable, and it held only while nobody happened to have intent-guard
    // installed. Somebody does, so the suite went red on main over a fact
    // about a laptop rather than about the code.
    //
    // Naming the node and git directories instead of inheriting is not
    // enough either, and the reason is worth writing down because it is the
    // same mistake one step further in: a global npm install puts its bin
    // symlink in THE SAME DIRECTORY AS NODE. On the machine that found this,
    // intent-guard sits beside node in an nvm bin directory, so adding "the
    // node directory" to PATH re-adds intent-guard and the test is
    // machine-dependent again. /usr/bin, where git lives, is a shared
    // directory with the same property in principle.
    //
    // So every entry on this PATH is a file this test wrote: the three gate
    // shims, the umbrella, node, and git. "intent-guard is not findable" is
    // then true by construction, and stays true on any machine, because
    // there is nowhere for it to be.
    env = childEnv(binDir);
  });

  afterAll(() => {
    if (clone !== '') {
      rmSync(path.dirname(clone), { recursive: true, force: true });
    }
  });

  it('init writes one policy file and one hook, and enables what it found', () => {
    const result = conductor(['init']);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(clone, '.guardrails.yaml'))).toBe(true);
    expect(existsSync(path.join(clone, '.git', 'hooks', 'pre-commit'))).toBe(true);

    const policy = readFileSync(path.join(clone, '.guardrails.yaml'), 'utf8');
    expect(policy).toMatch(/dependencies:\n\s+product: dep-guard\n\s+enabled: true/);
    expect(policy).toMatch(/secrets:\n\s+product: vault-guard\n\s+enabled: true/);
    // Not on PATH and not in node_modules/.bin, which is now true BY
    // CONSTRUCTION: the child's PATH is built from three named directories
    // and intent-guard is in none of them. init leaves it off and says why
    // rather than silently switching on a gate that is not there.
    expect(policy).toMatch(/intent:\n\s+product: intent-guard\n\s+enabled: false/);
  });

  it('reaches the unpublished gate through an absolute command in the policy', () => {
    // The dependency gate needs a corpus this clone does not carry, and the
    // intent gate needs a build that is not installed anywhere. Both are
    // expressed in the policy: one as a passthrough flag, one as a command
    // override.
    writeFileSync(
      path.join(clone, '.guardrails.yaml'),
      [
        'version: 1',
        'gates:',
        '  dependencies:',
        '    product: dep-guard',
        '    enabled: true',
        '    options:',
        `      corpus-dir: ${DEP_GUARD_CORPUS}`,
        '  secrets:',
        '    product: vault-guard',
        '    enabled: true',
        '  intent:',
        '    product: intent-guard',
        '    enabled: true',
        `    command: ${INTENT_GUARD_CLI}`,
        '',
        'report:',
        '  format: text',
        '',
      ].join('\n')
    );

    // A frozen contract with a change budget, so the intent gate has
    // something real to enforce.
    execFileSync(process.execPath, [INTENT_GUARD_CLI, 'init', '--project', '.'], { cwd: clone });
    execFileSync(
      process.execPath,
      [
        INTENT_GUARD_CLI,
        'extract',
        '--project',
        '.',
        '--text',
        'Update the readme only. Do not add dependencies. Do not touch source files.',
      ],
      { cwd: clone }
    );
    execFileSync(
      process.execPath,
      [INTENT_GUARD_CLI, 'freeze', '--project', '.', '--approved-by', 'dogfood'],
      { cwd: clone }
    );
    const contractPath = frozenContractIn(clone);
    writeFileSync(
      contractPath,
      readFileSync(contractPath, 'utf8').replace(
        'constraints: []',
        'constraints: []\nbudget:\n  allow_new_dependencies: false\n  max_files: 1'
      )
    );

    const result = conductor(['run']);
    // Not a clean run, but it ran: every gate resolved and answered.
    expect(result.stdout).toMatch(/dep-guard/);
    expect(result.stdout).toMatch(/vault-guard/);
    expect(result.stdout).toMatch(/intent-guard/);
    expect(result.stdout).not.toMatch(/DID NOT RUN/);
  });

  it('refuses the commit when a fake secret and a hallucinated dependency are staged', () => {
    const manifestPath = path.join(clone, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = { ...(manifest.dependencies ?? {}), lodahs: '1.0.0' };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // Fabricated. Matches the shape of a GitHub token and no real account.
    writeFileSync(
      path.join(clone, 'leak.js'),
      "const token = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';\nmodule.exports = token;\n"
    );

    git(['add', 'package.json', 'leak.js']);

    const commit = spawnSync('git', ['commit', '-m', 'this should not land'], {
      cwd: clone,
      encoding: 'utf8',
      env,
    });

    expect(commit.status).not.toBe(0);
    // The hook ran the umbrella, and the umbrella refused.
    expect(`${commit.stdout}${commit.stderr}`).toMatch(/conductor: a gate blocked this commit/);
  });

  it('names the right findings in the text report', () => {
    const result = conductor(['run', '--staged']);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/dep-guard\/typosquat/);
    expect(result.stdout).toMatch(/lodahs/);
    expect(result.stdout).toMatch(/vault-guard\/github-token/);
    expect(result.stdout).toMatch(/leak\.js:1:/);
    expect(result.stdout).toMatch(/intent-guard\/budget\.allow_new_dependencies/);
    expect(result.stdout).toMatch(/verdict: exit 1/);
  });

  it('names the right findings in the SARIF log, one run per gate', () => {
    const result = conductor(['run', '--staged', '--format', 'sarif']);

    expect(result.status).toBe(1);
    const log = JSON.parse(result.stdout) as {
      version: string;
      runs: Array<{
        tool: { driver: { name: string; version?: string } };
        results: Array<{
          ruleId: string;
          partialFingerprints?: Record<string, string>;
          properties: Record<string, unknown>;
        }>;
      }>;
    };

    expect(log.version).toBe('2.1.0');
    expect(log.runs.map((run) => run.tool.driver.name)).toEqual([
      'dep-guard',
      'vault-guard',
      'intent-guard',
    ]);
    for (const run of log.runs) {
      // Read from each binary's own --version, so this must be a real
      // version rather than a placeholder.
      expect(run.tool.driver.version).toMatch(/^\d+\.\d+\.\d+/);
    }

    const ruleIds = log.runs.flatMap((run) => run.results.map((entry) => entry.ruleId));
    expect(ruleIds).toContain('dep-guard/typosquat');
    expect(ruleIds).toContain('vault-guard/github-token');
    expect(ruleIds).toContain('intent-guard/budget.allow_new_dependencies');

    const secret = log.runs[1].results[0];
    expect(Object.keys(secret.partialFingerprints ?? {})).toEqual(['vault-guard/v1']);
    expect(secret.properties.blocking).toBe(true);
  });

  it('reports a missing enabled gate as a blocking finding and exits 2', () => {
    // The same policy, run with a PATH that has neither gate shim on it. The
    // intent gate still runs, because its absolute command does not depend
    // on PATH; the other two are enabled and absent. A silent skip here is
    // the whole failure mode this umbrella exists to avoid.
    //
    // git IS on that PATH, and nothing else is. The CLI needs it to find the
    // working-tree root and says so plainly when it is missing, so without
    // the shim this test would exit 2 over git and never reach the question
    // it is about.
    const emptyDir = path.join(path.dirname(binDir), 'empty');
    mkdirSync(emptyDir, { recursive: true });
    shimGit(emptyDir);
    const result = spawnSync(process.execPath, [CONDUCTOR_CLI, 'run', '--staged'], {
      cwd: clone,
      encoding: 'utf8',
      env: { ...env, PATH: emptyDir },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/conductor\/gate-missing/);
    expect(result.stdout).toMatch(/DID NOT RUN/);
    expect(result.stdout).toMatch(/verdict: exit 2/);
  });

  it('reverts the hook but leaves the hand-edited policy file, and says so', () => {
    git(['reset', '--quiet']);
    rmSync(path.join(clone, 'leak.js'), { force: true });
    git(['checkout', '--', 'package.json']);

    // The policy file was rewritten by hand earlier in this file, so this is
    // a PARTIAL revert: the hook goes, the edited file stays, and the exit
    // code says something was left behind rather than reporting success.
    const result = conductor(['init', '--revert']);

    expect(result.status).toBe(2);
    expect(existsSync(path.join(clone, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(existsSync(path.join(clone, '.guardrails.yaml'))).toBe(true);
    expect(result.stderr).toMatch(/changed since init, left alone/);
    // The manifest survives, still describing what is left.
    expect(existsSync(path.join(clone, '.guardrails', 'manifest.json'))).toBe(true);
  });

  it('finishes the job under --force', () => {
    const result = conductor(['init', '--revert', '--force']);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(clone, '.guardrails.yaml'))).toBe(false);
    expect(existsSync(path.join(clone, '.guardrails', 'manifest.json'))).toBe(false);
  });

  /**
   * Pull-request mode, against the real gates and a real branch.
   *
   * The block above left the clone with no policy file and no hook, which is
   * where this starts. It commits an honest policy and the contract frozen
   * earlier as the BASE, then commits the attack as the head: the policy
   * rewritten to point the secrets gate's `command:` at a script the same
   * commit adds, the dependency gate switched off, a fabricated secret, and
   * the frozen contract's approval rewritten to name the pull request itself.
   *
   * The attacker's script writes a marker file, so "did the pull request's
   * own code run on the runner" is answered by looking on disk rather than by
   * reading a command line. This is the case the whole release exists for and
   * the one thing in this file no unit test can stand in for: every stub in
   * the suite prints what the test told it to, and the question here is what
   * a real intent-guard, a real vault-guard and a real dep-guard do when the
   * rules are taken away from the tree they are judging.
   */
  describe('a pull request that rewrites the rules it is judged by', () => {
    let marker = '';
    let attacker = '';

    beforeAll(() => {
      marker = path.join(path.dirname(clone), 'attacker-ran.txt');

      // The base: an honest policy, and the contract frozen earlier in this
      // file, which is still on disk.
      writeFileSync(
        path.join(clone, '.guardrails.yaml'),
        [
          'version: 1',
          'gates:',
          '  dependencies:',
          '    product: dep-guard',
          '    enabled: true',
          '    options:',
          `      corpus-dir: ${DEP_GUARD_CORPUS}`,
          '  secrets:',
          '    product: vault-guard',
          '    enabled: true',
          '  intent:',
          '    product: intent-guard',
          '    enabled: true',
          `    command: ${INTENT_GUARD_CLI}`,
          '    enforce: false',
          '',
        ].join('\n')
      );
      git(['add', '-A']);
      git(['commit', '--quiet', '-m', 'base: an honest policy and a frozen contract']);
      git(['branch', '-f', 'trust-base-fixture']);

      // The pull request.
      attacker = path.join(clone, 'tools', 'nice-gate.sh');
      shim(
        path.dirname(attacker),
        'nice-gate.sh',
        [
          '#!/bin/sh',
          `printf 'ran\\n' > ${JSON.stringify(marker)}`,
          `echo '{"version":"1","summary":{"files":0,"secrets":0},"run":{"files_scanned":0,"patterns_active":0,"fail_on":"medium","blocking_matches":0},"results":[]}'`,
          'exit 0',
        ].join('\n') + '\n'
      );
      writeFileSync(
        path.join(clone, '.guardrails.yaml'),
        [
          'version: 1',
          'gates:',
          '  dependencies:',
          '    product: dep-guard',
          '    enabled: false',
          '  secrets:',
          '    product: vault-guard',
          '    enabled: true',
          `    command: ${attacker}`,
          '    args: []',
          '  intent:',
          '    product: intent-guard',
          '    enabled: true',
          `    command: ${INTENT_GUARD_CLI}`,
          '    enforce: false',
          '',
        ].join('\n')
      );
      // Fabricated. The shape of a GitHub token and no real account.
      writeFileSync(
        path.join(clone, 'leak.js'),
        "const token = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';\nmodule.exports = token;\n"
      );
      // And the contract's approval rewritten to name the pull request.
      const contractPath = frozenContractIn(clone);
      writeFileSync(
        contractPath,
        readFileSync(contractPath, 'utf8').replace(/approved_by: .*/, 'approved_by: this branch')
      );
      git(['add', '-A']);
      git(['commit', '--quiet', '-m', 'feat: a helpful refactor']);
    });

    it('runs the pull request own script when no trust base is passed, which is the hole', () => {
      rmSync(marker, { force: true });

      const result = conductor(['run']);

      expect(existsSync(marker)).toBe(true);
      expect(result.stdout).not.toMatch(/vault-guard\/github-token/);
      expect(result.stdout).not.toMatch(/dependencies\s+dep-guard/);
    });

    it('never runs it with a trust base, and the real gates report what it hid', () => {
      rmSync(marker, { force: true });

      const result = conductor(['run', '--trust-base', 'trust-base-fixture', '--verbose']);

      expect(existsSync(marker)).toBe(false);
      // The base policy's gates, including the one the pull request switched
      // off, and the secret its own gate would have swallowed.
      expect(result.stdout).toMatch(/dependencies\s+dep-guard/);
      expect(result.stdout).toMatch(/vault-guard\/github-token/);
      expect(result.stdout).toMatch(/leak\.js:1:/);
    });

    it('sums the umbrella own proposal and the gate own into one sentence', () => {
      const result = conductor(['run', '--trust-base', 'trust-base-fixture', '--verbose']);

      expect(result.stdout).toMatch(/2 control change\(s\) proposed in this pull request\./);
      expect(result.stdout).toMatch(/proposed\s+conductor\s+policy changed in this pull request/);
      expect(result.stdout).toMatch(
        /proposed\s+intent-guard\s+contract changed in this pull request/
      );
    });

    it('refuses the forged approval, as an ordinary blocking finding', () => {
      const result = conductor(['run', '--trust-base', 'trust-base-fixture', '--verbose']);

      expect(result.stdout).toMatch(/BLOCKING.*intent-guard\/gate-blocked/);
      expect(result.stdout).toMatch(/Self-approval refused:/);
    });

    it('says of each gate whether it was put into pull-request mode', () => {
      const result = conductor(['run', '--trust-base', 'trust-base-fixture', '--verbose']);

      // Every gate here is whatever this machine has installed or has built
      // beside this repository, which is the whole point of this suite, so
      // the assertion is about the RULE and not about a version number: at
      // or above its floor a gate is inside the boundary and silent, below
      // it the line is there. BOTH directions have to hold, or the withheld
      // line is decoration that nothing would notice the loss of.
      const floors: Array<[string, string, string]> = [
        ['dependencies', 'dep-guard', '0.6.0'],
        ['secrets', 'vault-guard', '1.7.0'],
        ['intent', 'intent-guard', '1.4.0'],
      ];

      for (const [role, product, floor] of floors) {
        const version =
          new RegExp(`${role}\\s+${product}\\s+(\\S+)`).exec(result.stdout)?.[1] ?? null;
        const withheld = new RegExp(
          `NOT in pull-request mode\\s+${role}\\s+${product}`
        ).test(result.stdout);
        expect({ role, inBoundary: !withheld }).toEqual({
          role,
          inBoundary: atLeastVersion(version, floor),
        });
      }
    });

    it('fails closed for every enabled gate on a base ref that does not resolve', () => {
      rmSync(marker, { force: true });

      const result = conductor(['run', '--trust-base', 'origin/does-not-exist']);

      expect(result.status).toBe(2);
      expect(existsSync(marker)).toBe(false);
      expect(result.stdout).toMatch(/does not resolve to a commit/);
      expect(result.stdout).toMatch(/verdict: exit 2/);
    });

    it('writes a SARIF log whose every result has a location', () => {
      // The adjacent fix, checked where it was found: against a real
      // repository's real gate output rather than against a constructed
      // result. One result without a location makes code scanning reject the
      // whole log.
      const result = conductor([
        'run',
        '--trust-base',
        'trust-base-fixture',
        '--format',
        'sarif',
      ]);
      const log = JSON.parse(result.stdout) as {
        runs: Array<{
          results: Array<{ ruleId: string; locations?: unknown[] }>;
          invocations?: Array<{ toolExecutionNotifications?: Array<{ descriptor: { id: string } }> }>;
        }>;
      };

      const results = log.runs.flatMap((run) => run.results);
      expect(results.length).toBeGreaterThan(0);
      expect(
        results.filter((entry) => (entry.locations?.length ?? 0) === 0).map((entry) => entry.ruleId)
      ).toEqual([]);

      const notificationIds = log.runs.flatMap((run) =>
        (run.invocations ?? []).flatMap((invocation) =>
          (invocation.toolExecutionNotifications ?? []).map((entry) => entry.descriptor.id)
        )
      );
      expect(notificationIds).toContain('conductor/control-change-proposed');
      // Nothing about trust-base-not-passed here. This test is about
      // locations and about a proposal reaching the log; whether any gate
      // was left OUTSIDE the boundary depends on what this machine has
      // installed, and asserting it either way here would make this test a
      // second, weaker copy of the version-aware one above. It used to
      // assert the notification was PRESENT, which stopped being true the
      // week dep-guard shipped its half.
    });

    /**
     * The adopter shape this release is actually about.
     *
     * Every repository in this family installs the gates as devDependencies
     * for its own hooks, so a real pull request run has a
     * node_modules/.bin/<gate> sitting there for resolution to find. Under
     * 0.3.0 resolution took it and the program check refused it, which is
     * safe and turned three ordinary gates into three refusals and exit 2.
     *
     * Measured with a marker, not with a source field: the planted binaries
     * write a file if anything executes them, --version included, so "the
     * PATH one ran" is a fact about the filesystem.
     */
    describe('the gates also installed as devDependencies, which is every repository here', () => {
      const planted = () => path.join(clone, 'node_modules');
      let plantMarker = '';

      beforeAll(() => {
        plantMarker = path.join(path.dirname(clone), 'planted-ran.txt');
        for (const name of ['dep-guard', 'vault-guard']) {
          shim(
            path.join(planted(), '.bin'),
            name,
            [
              '#!/bin/sh',
              `printf 'ran\\n' >> ${JSON.stringify(plantMarker)}`,
              'if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi',
              'exit 0',
            ].join('\n') + '\n'
          );
        }
      });

      afterAll(() => {
        rmSync(planted(), { recursive: true, force: true });
        rmSync(plantMarker, { force: true });
      });

      it('runs the gates on PATH and executes neither planted copy', () => {
        rmSync(plantMarker, { force: true });
        rmSync(marker, { force: true });

        const result = conductor(['run', '--trust-base', 'trust-base-fixture', '--verbose']);

        expect(existsSync(plantMarker)).toBe(false);
        // Not merely "no crash": the real gates ran and reported what the
        // pull request tried to hide, which is the same verdict this fixture
        // reaches with no node_modules in it at all.
        expect(result.stdout).toMatch(/vault-guard\/github-token/);
        expect(result.stdout).toMatch(/dependencies\s+dep-guard/);
        expect(result.stdout).not.toMatch(/gate-program-refused/);
      });

      it('says which copies it declined, once, naming both', () => {
        const result = conductor(['run', '--trust-base', 'trust-base-fixture', '--verbose']);

        const lines = result.stdout
          .split('\n')
          .filter((line) => line.includes('node_modules/.bin not consulted'));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/dependencies \(dep-guard\) at node_modules\/\.bin\/dep-guard/);
        expect(lines[0]).toMatch(/secrets \(vault-guard\) at node_modules\/\.bin\/vault-guard/);
      });

      it('raises one conductor/node-modules-skipped notification in the SARIF log', () => {
        const result = conductor([
          'run',
          '--trust-base',
          'trust-base-fixture',
          '--format',
          'sarif',
        ]);
        const log = JSON.parse(result.stdout) as {
          runs: Array<{
            invocations?: Array<{
              toolExecutionNotifications?: Array<{ descriptor: { id: string }; level: string }>;
            }>;
          }>;
        };

        const skipped = log.runs
          .flatMap((run) => run.invocations ?? [])
          .flatMap((invocation) => invocation.toolExecutionNotifications ?? [])
          .filter((entry) => entry.descriptor.id === 'conductor/node-modules-skipped');

        expect(skipped).toHaveLength(1);
        expect(skipped[0]?.level).toBe('note');
      });

      it('takes the planted copy when there is no trust base, which is unchanged', () => {
        // The parity case, and it has to be measured here rather than assumed
        // from a unit test: a pre-commit hook in one of these repositories is
        // meant to run the pin, and this is the run that proves it still does.
        //
        // A policy of its own, restored afterwards. This fixture's head policy
        // points the secrets gate at the attacker script with a `command:`,
        // which overrides resolution entirely, so a run under it would never
        // reach node_modules whatever the mode and would prove nothing.
        const policyPath = path.join(clone, '.guardrails.yaml');
        const headPolicy = readFileSync(policyPath, 'utf8');
        rmSync(plantMarker, { force: true });
        writeFileSync(
          policyPath,
          ['version: 1', 'gates:', '  secrets:', '    product: vault-guard', '    enabled: true', ''].join('\n')
        );

        try {
          conductor(['run']);
        } finally {
          writeFileSync(policyPath, headPolicy);
        }

        expect(existsSync(plantMarker)).toBe(true);
      });
    });
  });

  /**
   * The secrets gate inside the boundary, against a known vault-guard build.
   *
   * Reached through the policy's absolute `command:`, the same way the intent
   * gate is, so this case pins the version rather than reading whatever the
   * machine installed. The pull request changes vault-guard's own config to
   * ignore the file the secret is in: without pull-request mode that config
   * is obeyed and the secret is missed, and with it the config comes from the
   * base ref, the secret is reported anyway, and the attempt shows as a
   * proposal beside the umbrella's own.
   */
  (existsSync(VAULT_GUARD_CLI) ? describe : describe.skip)(
    'the secrets gate reading its own config from the base ref',
    () => {
      beforeAll(() => {
        git(['checkout', '--quiet', 'trust-base-fixture']);
        git(['checkout', '--quiet', '-B', 'vault-guard-base']);
        writeFileSync(
          path.join(clone, '.guardrails.yaml'),
          [
            'version: 1',
            'gates:',
            '  secrets:',
            '    product: vault-guard',
            '    enabled: true',
            `    command: ${VAULT_GUARD_CLI}`,
            '',
          ].join('\n')
        );
        git(['add', '-A']);
        git(['commit', '--quiet', '-m', 'base: the secrets gate on a known build']);
        git(['branch', '-f', 'vault-guard-fixture']);

        writeFileSync(
          path.join(clone, 'leak.js'),
          "const token = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';\nmodule.exports = token;\n"
        );
        // The pull request's own muting: ignore the file it just added.
        //
        // `ignore` takes an object of path/pattern lists, not a bare array;
        // that has been the only shape vault-guard's own schema accepts
        // since 1.0.0. A bare array here used to slip past silently in this
        // fixture but a current vault-guard build now refuses it outright
        // (config error, exit 1) instead of applying it, which turned this
        // case into a false pass: the gate never actually read the ignore
        // rule the test means to exercise.
        writeFileSync(
          path.join(clone, '.vault-guard.json'),
          `${JSON.stringify({ ignore: { paths: ['leak.js'] } }, null, 2)}\n`
        );
        git(['add', '-A']);
        git(['commit', '--quiet', '-m', 'feat: tidy up the scanner config']);
      });

      it('obeys the pull request own config when no trust base is passed', () => {
        const result = conductor(['run', '--verbose']);

        // Version-agnostic on purpose: this case is about the gate reading
        // and applying its own config, not about which vault-guard build is
        // installed. Pinning the exact version here went stale the moment a
        // newer build changed nothing about the behavior under test, so the
        // check is "the secrets gate ran to completion under whatever
        // vault-guard is wired in" (any semver, exit 0, not a config error
        // or a DID NOT RUN) rather than a specific number.
        expect(result.stdout).toMatch(/secrets\s+vault-guard\s+\d+\.\d+\.\d+\s+exit 0/);
        expect(result.stdout).not.toMatch(/vault-guard\/github-token/);
      });

      it('takes the config from the base ref and reports the secret anyway', () => {
        const result = conductor(['run', '--trust-base', 'vault-guard-fixture', '--verbose']);

        expect(result.stdout).toMatch(/vault-guard\/github-token/);
        expect(result.stdout).toMatch(/leak\.js:1:/);
        expect(result.stdout).not.toMatch(/NOT in pull-request mode\s+secrets/);
      });

      it("reports the muting attempt as that gate's own proposal", () => {
        const result = conductor(['run', '--trust-base', 'vault-guard-fixture', '--verbose']);

        // The sentence is vault-guard's, carried verbatim: this package does
        // not read that gate's control files and has no standing to describe
        // what changed in them.
        expect(result.stdout).toMatch(/proposed\s+vault-guard\s+config added in this pull request/);
        expect(result.stdout).toMatch(/1 control change\(s\) proposed in this pull request\./);
      });

      it('raises no policy line, because this pull request left the policy alone', () => {
        // The other direction, and it is what keeps the count worth reading:
        // the head and base policies are identical here, so the umbrella's
        // own line is absent and the only proposal is the gate's.
        const result = conductor(['run', '--trust-base', 'vault-guard-fixture', '--verbose']);

        expect(result.stdout).not.toMatch(/policy changed in this pull request/);
      });
    }
  );
});

/**
 * THE COMPOSED TEST. The design document calls this the acceptance criterion
 * for the whole trust-boundary wave, and it is the only test here that
 * exercises all three gates in pull-request mode at once.
 *
 * One fixture repository with all three gates adopted and a frozen contract.
 * One pull request that, in a single commit, does everything the design says
 * an attacker would: rewrites the contract's scope AND its approval, adds
 * `severity_overrides` and `ignore: **` to vault-guard's config, adds an
 * allow entry to dep-guard's config, points conductor's own `command:` for
 * one gate at a script the same commit adds, and carries the three things
 * those four changes exist to hide -- a real-shaped secret, a dependency name
 * the corpus does not know, and a file outside the contract's scope.
 *
 * The run must execute NONE of the head-side controls, report EVERY one of
 * them as proposed, and block on the secret, the dependency and the contract
 * exactly as it would have on the base configuration.
 *
 * It runs twice: once against the sibling checkouts' built CLIs through the
 * policy's absolute `command:`, which pins the versions, and once against
 * whatever is on PATH, which is what an adopter actually gets. The second
 * skips unless every PATH binary is at or above its floor, and says so.
 */
interface ComposedFixture {
  repo: string;
  bin: string;
  marker: string;
}

/** Versions of the three gates on PATH, or null where one could not be read. */
function pathVersions(): Record<string, string | null> {
  const read = (name: string): string | null => {
    const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
    const value = (probe.stdout ?? '').trim().split('\n')[0]?.trim() ?? '';
    return probe.status === 0 && /^v?\d+\.\d+\.\d+/.test(value) ? value.replace(/^v/, '') : null;
  };
  return {
    'dep-guard': read('dep-guard'),
    'vault-guard': read('vault-guard'),
    'intent-guard': read('intent-guard'),
  };
}

/** A binary on PATH, resolved once so a shim can exec something real. */
function onPath(name: string): string | null {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const value = (found.stdout ?? '').trim();
  return found.status === 0 && value.length > 0 ? value : null;
}

const PATH_VERSIONS = pathVersions();
const PATH_READY =
  atLeastVersion(PATH_VERSIONS['dep-guard'], '0.6.0') &&
  atLeastVersion(PATH_VERSIONS['vault-guard'], '1.7.0') &&
  atLeastVersion(PATH_VERSIONS['intent-guard'], '1.4.0');

const composedMissing = [
  ...missing,
  existsSync(DEP_GUARD_FIXTURE_CORPUS) ? null : 'dep-guard has no committed fixture corpus',
  existsSync(VAULT_GUARD_CLI) ? null : 'no vault-guard build to drive through command:',
].filter((entry): entry is string => entry !== null);

const describeComposed = composedMissing.length === 0 ? describe : describe.skip;

describeComposed('the composed test: a pull request that tries to mute all three gates', () => {
  const scratch: string[] = [];

  afterAll(() => {
    for (const dir of scratch) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Builds the fixture. `commands` names an absolute binary per role, or is
   * null to leave every gate to resolution, which is the PATH variant.
   */
  function composedFixture(commands: Record<string, string> | null): ComposedFixture {
    const root = mkdtempSync(path.join(SCRATCH_PARENT, 'conductor-composed-'));
    scratch.push(root);
    const repo = path.join(root, 'repo');
    const bin = path.join(root, 'bin');
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const marker = path.join(root, 'attacker-ran.txt');

    const run = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    };
    const put = (relative: string, body: string, mode?: number): string => {
      const file = path.join(repo, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
      if (mode !== undefined) chmodSync(file, mode);
      return file;
    };

    shim(bin, 'node', `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    const gitBinary = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    shim(bin, 'git', `#!/bin/sh\nexec ${gitBinary} "$@"\n`);
    if (commands === null) {
      // Shimmed rather than inheriting PATH, for the reason the block above
      // records at length: a global install sits in the same directory as
      // node, so naming that directory re-adds gates this fixture did not
      // choose and the suite's verdict becomes a fact about a laptop.
      for (const name of ['dep-guard', 'vault-guard', 'intent-guard']) {
        shim(bin, name, `#!/bin/sh\nexec ${onPath(name) as string} "$@"\n`);
      }
    }

    run(['init', '--quiet', '-b', 'main']);
    run(['config', 'user.email', 'composed@example.com']);
    run(['config', 'user.name', 'Composed']);

    const policy = (secretsCommand: string | null): string =>
      [
        'version: 1',
        'gates:',
        '  dependencies:',
        '    product: dep-guard',
        '    enabled: true',
        // No `args:` beside a real gate's `command:`. An empty args list
        // REPLACES the candidate table's argument prefix, which is how each
        // of these binaries is told which subcommand to run, so `args: []`
        // hands dep-guard `--format` as its first token and it exits 2 on an
        // unknown option. Resolution infers the prefix from the basename, or
        // falls back to the product's first candidate, which is what these
        // dist entry points need. The attacker script below DOES take
        // `args: []`, because it is not a real gate and takes no subcommand.
        ...(commands === null ? [] : [`    command: ${commands['dep-guard']}`]),
        '    options:',
        `      corpus-dir: ${DEP_GUARD_FIXTURE_CORPUS}`,
        '      online: false',
        '  secrets:',
        '    product: vault-guard',
        '    enabled: true',
        ...(secretsCommand === null
          ? commands === null
            ? []
            : [`    command: ${commands['vault-guard']}`]
          : [`    command: ${secretsCommand}`, '    args: []']),
        '  intent:',
        '    product: intent-guard',
        '    enabled: true',
        ...(commands === null ? [] : [`    command: ${commands['intent-guard']}`]),
        '',
      ].join('\n');

    // -- the base: three gates adopted, a frozen contract, nothing to find --
    put('package.json', `${JSON.stringify({ name: 'composed', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }, null, 2)}\n`);
    put('docs/readme.md', '# the only thing this branch is allowed to touch\n');
    put('src/app.js', 'module.exports = () => 1;\n');
    put('.guardrails.yaml', policy(null));

    // The contract is made by the SAME intent-guard the run will use, so the
    // fixture cannot be frozen by one version and judged by another.
    const intentGuard = commands === null ? (onPath('intent-guard') as string) : commands['intent-guard'];
    const runIntent = (rest: string[]): void => {
      if (intentGuard.endsWith('.js')) {
        execFileSync(process.execPath, [intentGuard, ...rest], { cwd: repo });
      } else {
        execFileSync(intentGuard, rest, { cwd: repo });
      }
    };
    runIntent(['init', '--project', '.']);
    runIntent([
      'extract',
      '--project',
      '.',
      '--text',
      'Update docs/readme.md only. Do not add dependencies. Do not touch src.',
    ]);
    runIntent(['freeze', '--project', '.', '--approved-by', 'a human reviewer', '--yes']);

    run(['add', '-A']);
    run(['commit', '--quiet', '-m', 'base: three gates, a frozen contract']);
    run(['branch', 'base']);

    // -- the pull request: four control changes and three things to hide --

    // 1. conductor's own policy, pointing the secrets gate at a script this
    //    same commit adds. The script writes a marker and reports clean.
    const attacker = put(
      'tools/nice-gate.sh',
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "1.7.0"; exit 0; fi',
        `printf 'ran\\n' > ${JSON.stringify(marker)}`,
        `echo '{"version":"1","summary":{"files":0,"secrets":0},"run":{"files_scanned":0,"patterns_active":0,"fail_on":"medium","blocking_matches":0},"results":[]}'`,
        'exit 0',
      ].join('\n') + '\n',
      0o755
    );
    put('.guardrails.yaml', policy(attacker));

    // 2. vault-guard's config: ignore everything, and downgrade what is left.
    put(
      '.vault-guard.json',
      `${JSON.stringify({ ignore: ['**'], severity_overrides: { 'github-token': 'low' }, fail_on: 'critical' }, null, 2)}\n`
    );

    // 3. dep-guard's config: allow the name this commit is about to add.
    put('.dep-guard.json', `${JSON.stringify({ allow: ['lodahs'] }, null, 2)}\n`);

    // 4. the frozen contract: widen the scope and re-approve it in the same
    //    breath, which is the forgery the self-approval refusal exists for.
    // Two edits in one file: the scope is widened to everything, and the
    // approval is rewritten in the same breath. The indentation matches the
    // list the freeze wrote, so the head contract stays VALID YAML: an
    // invalid one would be refused for the wrong reason and the run without
    // a trust base would not show the widened scope being obeyed, which is
    // the half that makes the other half evidence.
    const contractPath = frozenContractIn(repo);
    writeFileSync(
      contractPath,
      readFileSync(contractPath, 'utf8')
        .replace(/approved_by: .*/, 'approved_by: this pull request')
        // A phrase rather than a glob: the contract schema refuses a scope
        // entry under five characters, so "**" is rejected as invalid before
        // it is rejected as a proposal, which would prove the wrong thing.
        .replace(/^in_scope:\n/m, 'in_scope:\n  - Everything anywhere in this repository\n')
    );

    // And the three things those four changes exist to hide. The token is
    // built from fragments so no string in THIS repository matches a secret
    // pattern; what lands in the fixture is the assembled, real-shaped value.
    const token = `ghp${'_'}${['A1b2C3d4E5f6', 'G7h8I9j0K1l2', 'M3n4O5p6Q7r8'].join('')}`;
    put('src/leak.js', `const token = '${token}';\nmodule.exports = token;\n`);
    put(
      'package.json',
      `${JSON.stringify({ name: 'composed', version: '1.0.0', dependencies: { lodash: '^4.17.21', lodahs: '^1.0.0' } }, null, 2)}\n`
    );
    put('src/out-of-scope.js', 'module.exports = "not docs/readme.md";\n');

    run(['add', '-A', '--force']);
    run(['commit', '--quiet', '-m', 'feat: a helpful refactor']);

    return { repo, bin, marker };
  }

  function conductorIn(fixture: ComposedFixture, args: string[]) {
    const result = spawnSync(process.execPath, [CONDUCTOR_CLI, ...args], {
      cwd: fixture.repo,
      encoding: 'utf8',
      env: childEnv(fixture.bin),
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  /** How many control changes the summary line reported. */
  function proposalCount(stdout: string): number {
    const match = /(\d+) control change\(s\) proposed in this pull request/.exec(stdout);
    return match === null ? -1 : Number(match[1]);
  }

  const SIBLING_COMMANDS = {
    'dep-guard': DEP_GUARD_CLI,
    'vault-guard': VAULT_GUARD_CLI,
    'intent-guard': INTENT_GUARD_CLI,
  };

  describe('driven through the sibling builds, which pins the versions', () => {
    let fixture: ComposedFixture;

    beforeAll(() => {
      fixture = composedFixture(SIBLING_COMMANDS);
    });

    it('obeys every head-side control when no trust base is passed, which is the hole', () => {
      rmSync(fixture.marker, { force: true });

      const result = conductorIn(fixture, ['run', '--verbose']);

      // The pull request's own gate ran, and the other two obeyed the
      // configs it added: nothing is reported and the run is green.
      expect(existsSync(fixture.marker)).toBe(true);
      expect(result.stdout).not.toMatch(/vault-guard\/github-token/);
      expect(result.stdout).not.toMatch(/lodahs/);
      expect(proposalCount(result.stdout)).toBe(-1);
    });

    it('executes none of them under a trust base', () => {
      rmSync(fixture.marker, { force: true });

      const result = conductorIn(fixture, ['run', '--trust-base', 'base', '--verbose']);

      expect(existsSync(fixture.marker)).toBe(false);
      expect(result.stdout).toMatch(/secrets\s+vault-guard/);
    });

    it('reports all four control changes as proposed', () => {
      const result = conductorIn(fixture, ['run', '--trust-base', 'base', '--verbose']);

      expect(proposalCount(result.stdout)).toBeGreaterThanOrEqual(4);
      expect(result.stdout).toMatch(/proposed\s+conductor\s+policy changed in this pull request/);
      expect(result.stdout).toMatch(/proposed\s+intent-guard\s+contract changed/);
      expect(result.stdout).toMatch(/proposed\s+vault-guard\s+config added/);
      expect(result.stdout).toMatch(/proposed\s+dep-guard\s+config added/);
    });

    it('blocks on the secret, the dependency and the contract', () => {
      const result = conductorIn(fixture, ['run', '--trust-base', 'base', '--verbose']);

      expect(result.stdout).toMatch(/vault-guard\/github-token/);
      expect(result.stdout).toMatch(/lodahs/);
      expect(result.stdout).toMatch(/Self-approval refused:/);
      expect(result.status).toBe(1);
    });

    it('puts every gate inside the boundary, so nothing is withheld', () => {
      const result = conductorIn(fixture, ['run', '--trust-base', 'base', '--verbose']);

      expect(result.stdout).not.toMatch(/NOT in pull-request mode/);
    });
  });

  (PATH_READY ? describe : describe.skip)(
    'driven through the PATH binaries, which is what an adopter gets',
    () => {
      let fixture: ComposedFixture;

      beforeAll(() => {
        fixture = composedFixture(null);
      });

      it('reaches the same verdict with no command: override anywhere', () => {
        rmSync(fixture.marker, { force: true });

        const result = conductorIn(fixture, ['run', '--trust-base', 'base', '--verbose']);

        expect(existsSync(fixture.marker)).toBe(false);
        expect(proposalCount(result.stdout)).toBeGreaterThanOrEqual(4);
        expect(result.stdout).toMatch(/vault-guard\/github-token/);
        expect(result.stdout).toMatch(/lodahs/);
        expect(result.stdout).toMatch(/Self-approval refused:/);
        expect(result.stdout).not.toMatch(/NOT in pull-request mode/);
        // And nothing was skipped: this fixture has no node_modules at all,
        // so the line must be absent. Asserting its absence here is what
        // keeps it from becoming decoration that appears on every run: the
        // dogfood case above plants a node_modules/.bin and requires the same
        // line to be PRESENT, and the two together say it tracks something.
        expect(result.stdout).not.toMatch(/node_modules\/\.bin not consulted/);
        expect(result.status).toBe(1);
      });
    }
  );
});

if (missing.length > 0) {
  // Not a silent skip: a skipped end-to-end test that reads as a pass is
  // the same problem as a gate that is switched on and not installed.
  // eslint-disable-next-line no-console
  console.warn(`dogfood e2e skipped: ${missing.join('; ')}`);
}

if (composedMissing.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `dogfood: the COMPOSED test skipped: ${composedMissing.join('; ')}. ` +
      'That is the acceptance criterion for the whole trust-boundary wave, ' +
      'and nothing in it has been proven.'
  );
} else if (!PATH_READY) {
  // eslint-disable-next-line no-console
  console.warn(
    'dogfood: the composed test ran against the sibling builds only. The PATH ' +
      `binaries are dep-guard ${PATH_VERSIONS['dep-guard'] ?? 'unknown'}, vault-guard ` +
      `${PATH_VERSIONS['vault-guard'] ?? 'unknown'}, intent-guard ` +
      `${PATH_VERSIONS['intent-guard'] ?? 'unknown'}, and at least one is below its floor.`
  );
}

if (missing.length === 0 && !existsSync(VAULT_GUARD_CLI)) {
  // eslint-disable-next-line no-console
  console.warn(
    'dogfood: the vault-guard pull-request case skipped, no build at ' +
      'CONDUCTOR_VAULT_GUARD_CLI and none beside this repository. ' +
      'Nothing in that block has been proven.'
  );
}
