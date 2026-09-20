import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { childEnv, shimGit } from './helpers/child-env.js';
import {
  CLEAN_DEP_GUARD,
  CLEAN_INTENT_GUARD,
  CLEAN_VAULT_GUARD,
  stubGate,
} from './helpers/stub-gate.js';

const CONDUCTOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONDUCTOR_CLI = path.join(CONDUCTOR_ROOT, 'dist', 'cli.js');

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'conductor-cli-'));
  temps.push(dir);
  return dir;
}

const ALL_THREE_POLICY = [
  'version: 1',
  'gates:',
  '  dependencies:',
  '    product: dep-guard',
  '  secrets:',
  '    product: vault-guard',
  '  intent:',
  '    product: intent-guard',
  '',
].join('\n');

function repoWithPolicy(policy = ALL_THREE_POLICY): string {
  const dir = tempDir();
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
  writeFileSync(path.join(dir, '.guardrails.yaml'), policy);
  return dir;
}

function runCli(
  cwd: string,
  args: string[],
  pathValue: string,
  options: { git?: boolean } = {}
) {
  // Every run gets git on its controlled PATH, because the CLI needs git to
  // find the working-tree root and this file replaces PATH wholesale. One
  // test asks for it back off, which is the case that used to be invisible.
  if (options.git !== false) {
    shimGit(pathValue);
  }
  const result = spawnSync(process.execPath, [CONDUCTOR_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnv(pathValue),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// A stack frame as Node prints it: whitespace, "at ", then an identifier or
// a path. Matching "at " alone would fire on ordinary prose.
const STACK_FRAME = /^\s+at\s+\S+/m;

describe('the CLI never prints a stack trace for a gate failure', () => {
  const DRIFTED = JSON.stringify({
    findings: [null],
    suppressed: 0,
    ignored: 0,
    run: { failOn: 'medium', blockingMatches: 0, diagnostics: [] },
    exitCode: 0,
  });

  it('reports a drifted gate output as exit 2 with no stack frames', () => {
    const repo = repoWithPolicy();
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: DRIFTED, exit: 0 });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
    stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });

    const result = runCli(repo, ['run', '--staged'], bin);

    expect(result.status).toBe(2);
    expect(result.stderr).not.toMatch(STACK_FRAME);
    expect(result.stdout).not.toMatch(STACK_FRAME);
    expect(result.stdout).toMatch(/conductor\/gate-output-unparseable/);
    // And the other two gates still reported.
    expect(result.stdout).toMatch(/vault-guard/);
    expect(result.stdout).toMatch(/intent-guard/);
  });

  it('prints no stack frames when a gate exits with its could-not-run code', () => {
    const repo = repoWithPolicy();
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: '', stderr: 'corpus unreadable', exit: 2 });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
    stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });

    const result = runCli(repo, ['run', '--staged'], bin);

    expect(result.status).toBe(2);
    expect(result.stderr).not.toMatch(STACK_FRAME);
    expect(result.stdout).not.toMatch(STACK_FRAME);
  });

  it('prints no stack frames when a gate binary is missing', () => {
    const repo = repoWithPolicy();

    const result = runCli(repo, ['run', '--staged'], tempDir());

    expect(result.status).toBe(2);
    expect(result.stderr).not.toMatch(STACK_FRAME);
    expect(result.stdout).not.toMatch(STACK_FRAME);
    expect(result.stdout).toMatch(/conductor\/gate-missing/);
  });

  it('prints a one-line message and no stack for a policy file that will not parse', () => {
    const repo = repoWithPolicy('version: 1\ngates:\n  nonsense:\n    product: dep-guard\n');

    const result = runCli(repo, ['run'], tempDir());

    expect(result.status).toBe(2);
    expect(result.stderr).not.toMatch(STACK_FRAME);
    expect(result.stderr).toMatch(/nonsense/);
  });

  it('prints a one-line message and no stack when there is no policy file at all', () => {
    const dir = tempDir();
    spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });

    const result = runCli(dir, ['run'], tempDir());

    expect(result.status).toBe(2);
    expect(result.stderr).not.toMatch(STACK_FRAME);
    expect(result.stderr).toMatch(/conductor init/);
  });

  it('keeps the SARIF output parseable when a gate could not run', () => {
    const repo = repoWithPolicy();
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: DRIFTED, exit: 0 });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
    stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });

    const result = runCli(repo, ['run', '--staged', '--format', 'sarif'], bin);

    expect(result.status).toBe(2);
    const log = JSON.parse(result.stdout) as {
      runs: Array<{ tool: { driver: { name: string } }; results: Array<{ ruleId: string }> }>;
    };
    const umbrella = log.runs.find((run) => run.tool.driver.name === 'conductor');
    expect(umbrella?.results.map((entry) => entry.ruleId)).toContain(
      'conductor/gate-output-unparseable'
    );
  });
});

describe('conductor run --stage', () => {
  function allThreeStubbed(): string {
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: CLEAN_DEP_GUARD, exit: 0 });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
    stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });
    return bin;
  }

  it('runs the commit gates and defers the intent gate at --stage commit', () => {
    const result = runCli(
      repoWithPolicy(),
      ['run', '--staged', '--stage', 'commit', '--verbose'],
      allThreeStubbed()
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/dep-guard/);
    expect(result.stdout).toMatch(/vault-guard/);
    expect(result.stdout).toMatch(/deferred\s+intent/);
    expect(result.stdout).toMatch(/stage ci/);
  });

  it('runs every gate at --stage ci', () => {
    const result = runCli(
      repoWithPolicy(),
      ['run', '--staged', '--stage', 'ci', '--verbose'],
      allThreeStubbed()
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^conductor run: 3 gate\(s\)/m);
    expect(result.stdout).not.toMatch(/deferred/);
  });

  it('runs every gate with no --stage at all, exactly as v0.1 did', () => {
    const result = runCli(repoWithPolicy(), ['run', '--staged', '--verbose'], allThreeStubbed());

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^conductor run: 3 gate\(s\)/m);
    expect(result.stdout).not.toMatch(/deferred/);
  });

  it('refuses an unknown stage with exit 2 rather than quietly running everything', () => {
    // The dangerous failure is the silent one: a typo in a CI file that
    // makes the job run every gate, or none, and say nothing about it.
    const result = runCli(
      repoWithPolicy(),
      ['run', '--staged', '--stage', 'nightly'],
      allThreeStubbed()
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/nightly/);
    expect(result.stderr).toMatch(/commit, push, ci/);
    expect(result.stderr).not.toMatch(STACK_FRAME);
    // Nothing ran.
    expect(result.stdout).toBe('');
  });

  it('names the deferred gate in the SARIF log rather than dropping it', () => {
    const result = runCli(
      repoWithPolicy(),
      ['run', '--staged', '--stage', 'commit', '--format', 'sarif'],
      allThreeStubbed()
    );

    const log = JSON.parse(result.stdout) as {
      runs: Array<{
        tool: { driver: { name: string } };
        invocations?: Array<{
          toolExecutionNotifications: Array<{ descriptor: { id: string } }>;
        }>;
      }>;
    };
    const umbrella = log.runs.find((run) => run.tool.driver.name === 'conductor');
    expect(
      umbrella?.invocations?.[0].toolExecutionNotifications.map((entry) => entry.descriptor.id)
    ).toContain('conductor/gate-deferred');
    // And the gate that did not run got no run of its own.
    expect(log.runs.map((run) => run.tool.driver.name)).not.toContain('intent-guard');
  });
});

describe('a clean run through the CLI', () => {
  function allThreeStubbed(): string {
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: CLEAN_DEP_GUARD, exit: 0 });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
    stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });
    return bin;
  }

  it('prints one line, not a screenful, when nothing was found', () => {
    const result = runCli(repoWithPolicy(), ['run', '--staged'], allThreeStubbed());

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stdout).toMatch(/clean, nothing blocked/);
    expect(result.stdout).toMatch(/dependencies/);
    expect(result.stdout).toMatch(/secrets/);
    expect(result.stdout).toMatch(/intent/);
    expect(result.stdout).toMatch(/--verbose/);
  });

  it('prints the full report under --verbose', () => {
    const result = runCli(repoWithPolicy(), ['run', '--staged', '--verbose'], allThreeStubbed());

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^conductor run: 3 gate\(s\)/m);
    expect(result.stdout).toMatch(/^verdict: exit 0/m);
  });

  it('leaves the SARIF log alone, with or without --verbose', () => {
    const bin = allThreeStubbed();
    const quiet = runCli(repoWithPolicy(), ['run', '--staged', '--format', 'sarif'], bin);
    const loud = runCli(
      repoWithPolicy(),
      ['run', '--staged', '--format', 'sarif', '--verbose'],
      bin
    );

    expect(quiet.stdout).toBe(loud.stdout);
    expect(quiet.stdout.trimEnd().split('\n').length).toBeGreaterThan(1);
  });
});

describe('conductor run --output', () => {
  function allThreeStubbed(): string {
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: CLEAN_DEP_GUARD, exit: 0 });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
    stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });
    return bin;
  }

  it('writes the report to the file instead of to stdout', () => {
    const repo = repoWithPolicy();
    const target = path.join(tempDir(), 'conductor.sarif');

    const result = runCli(
      repo,
      ['run', '--staged', '--format', 'sarif', '--output', target],
      allThreeStubbed()
    );

    expect(result.status).toBe(0);
    const log = JSON.parse(readFileSync(target, 'utf8')) as { version: string };
    expect(log.version).toBe('2.1.0');
    expect(result.stdout).not.toMatch(/"version": "2\.1\.0"/);
  });

  it('still says on stdout that it ran and where the report went', () => {
    // A CI job whose only output is an uploaded artifact reads as a job that
    // did nothing. One line keeps the log honest.
    const repo = repoWithPolicy();
    const target = path.join(tempDir(), 'conductor.sarif');

    const result = runCli(
      repo,
      ['run', '--staged', '--format', 'sarif', '--output', target],
      allThreeStubbed()
    );

    expect(result.stdout).toContain(target);
  });

  it('keeps the exit code the run earned', () => {
    const repo = repoWithPolicy();
    const target = path.join(tempDir(), 'conductor.sarif');

    const result = runCli(
      repo,
      ['run', '--staged', '--format', 'sarif', '--output', target],
      tempDir()
    );

    expect(result.status).toBe(2);
  });

  it('reports an unwritable path as a run that could not be carried out', () => {
    const repo = repoWithPolicy();
    const target = path.join(tempDir(), 'no-such-directory', 'conductor.sarif');

    const result = runCli(
      repo,
      ['run', '--staged', '--format', 'sarif', '--output', target],
      allThreeStubbed()
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/conductor\.sarif/);
    expect(result.stderr).not.toMatch(STACK_FRAME);
  });
});

describe('conductor run from a subdirectory', () => {
  // The umbrella anchors everything at the working-tree root as reported by
  // git, so a run from a subdirectory behaves exactly like a run from the top.
  // Nothing pinned that: repoRoot falls back to the working directory when git
  // cannot answer, so a regression would degrade quietly into a policy file
  // nobody can find. The hook's equivalent rule is pinned at
  // tests/init.test.ts:1546; this is the CLI's half.
  // This suite replaces PATH wholesale so the gates resolve to stubs, which
  // also takes git away from the spawned CLI. That used to matter only here,
  // because repoRoot fell back to the working directory and everywhere else
  // the working directory IS the root; the shim it needed has since moved
  // into runCli, so every test in this file gets git and a run without it
  // says so rather than guessing.
  function allThreeStubbed(): string {
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: CLEAN_DEP_GUARD, exit: 0 });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
    stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });
    return bin;
  }

  it('finds the policy file at the root and reports exactly what a run from the top does', () => {
    const repo = repoWithPolicy();
    const nested = path.join(repo, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    const bin = allThreeStubbed();
    const fromRoot = path.join(tempDir(), 'root.sarif');
    const fromNested = path.join(tempDir(), 'nested.sarif');

    const rootRun = runCli(
      repo,
      ['run', '--staged', '--format', 'sarif', '--output', fromRoot],
      bin
    );
    const nestedRun = runCli(
      nested,
      ['run', '--staged', '--format', 'sarif', '--output', fromNested],
      bin
    );

    expect(rootRun.status).toBe(0);
    // Two levels down, so a fix that only walked up one would still fail here.
    expect(nestedRun.status).toBe(0);
    // The failure this guards against: anchoring at the subdirectory means no
    // policy file, which is exit 2 and a message telling the user to run init.
    expect(nestedRun.stderr).not.toMatch(/conductor init/);

    const report = JSON.parse(readFileSync(fromNested, 'utf8')) as {
      runs: Array<{ tool: { driver: { name: string } } }>;
    };
    const tools = report.runs.map((run) => run.tool.driver.name);
    expect(tools).toContain('dep-guard');
    expect(tools).toContain('vault-guard');
    expect(tools).toContain('intent-guard');

    expect(readFileSync(fromNested, 'utf8')).toBe(readFileSync(fromRoot, 'utf8'));
    // And nothing was anchored at the subdirectory on the way.
    expect(existsSync(path.join(nested, '.guardrails.yaml'))).toBe(false);
  });
});

describe('a gate with enforce: false', () => {
  const BLOCKING_VAULT_GUARD = JSON.stringify({
    version: '1',
    scannedAt: '2026-09-02T00:00:00.000Z',
    summary: { files: 1, secrets: 1 },
    run: {
      duration_ms: 1,
      files_scanned: 1,
      bytes_scanned: 40,
      patterns_active: 59,
      diagnostics_count: 0,
      fail_on: 'medium',
      blocking_matches: 1,
    },
    // The match shape is the one captured from vault-guard 1.4.2 in
    // tests/fixtures, not an invented one.
    results: [
      {
        file: 'src/config.js',
        matches: [
          {
            type: 'github-token',
            severity: 'critical',
            line: 2,
            column: 22,
            offset: 93,
            value: 'ghp_...(40c)',
            fingerprint: '85ce78fecbada885e18040c4ef1299a29367a1d2eec35fec239ab556a0172c79',
          },
        ],
      },
    ],
  });

  const SECRETS_UNENFORCED = [
    'version: 1',
    'gates:',
    '  secrets:',
    '    product: vault-guard',
    '    enforce: false',
    '',
  ].join('\n');

  it('exits 0 while the text report still shows the blocking findings', () => {
    const repo = repoWithPolicy(SECRETS_UNENFORCED);
    const bin = tempDir();
    stubGate(bin, 'vault-guard', { stdout: BLOCKING_VAULT_GUARD, exit: 1 });

    const result = runCli(repo, ['run', '--staged'], bin);

    expect(result.status).toBe(0);
    // The findings are not quieted to match the exit code.
    expect(result.stdout).toMatch(/BLOCKING/);
    expect(result.stdout).toMatch(/vault-guard\/github-token/);
    // And the green exit explains itself on the same screen.
    expect(result.stdout).toMatch(/not enforced/);
    expect(result.stdout).toMatch(/verdict: exit 0, but secrets blocked/);
  });

  it('keeps the findings at their own level in the SARIF log', () => {
    const repo = repoWithPolicy(SECRETS_UNENFORCED);
    const bin = tempDir();
    stubGate(bin, 'vault-guard', { stdout: BLOCKING_VAULT_GUARD, exit: 1 });

    const result = runCli(repo, ['run', '--staged', '--format', 'sarif'], bin);

    expect(result.status).toBe(0);
    const log = JSON.parse(result.stdout) as {
      runs: Array<{
        tool: { driver: { name: string } };
        properties?: { enforced?: boolean };
        results: Array<{ ruleId: string; level: string; properties: { blocking: boolean } }>;
        invocations?: Array<{
          toolExecutionNotifications: Array<{ descriptor: { id: string } }>;
        }>;
      }>;
    };

    const gateRun = log.runs.find((run) => run.tool.driver.name === 'vault-guard');
    expect(gateRun?.properties?.enforced).toBe(false);
    expect(gateRun?.results[0].level).toBe('error');
    expect(gateRun?.results[0].properties.blocking).toBe(true);

    const umbrella = log.runs.find((run) => run.tool.driver.name === 'conductor');
    expect(
      umbrella?.invocations?.[0].toolExecutionNotifications.map((entry) => entry.descriptor.id)
    ).toContain('conductor/gate-not-enforced');
  });

  it('exits 0 with a note when an unenforced gate could not run at all', () => {
    // Enforced, this is exit 2: a gate that verified nothing is worse than
    // one that failed. Unenforced, it is a note, and the report has to say
    // out loud that nothing was checked.
    const repo = repoWithPolicy(SECRETS_UNENFORCED);

    const result = runCli(repo, ['run', '--staged'], tempDir());

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/DID NOT RUN/);
    expect(result.stdout).toMatch(/conductor\/gate-missing/);
    expect(result.stdout).toMatch(/not enforced/);
    expect(result.stdout).toMatch(/verdict: exit 0, but secrets could not run/);
  });

  it('still exits 2 for an enforced gate standing beside an unenforced broken one', () => {
    const repo = repoWithPolicy(
      [
        'version: 1',
        'gates:',
        '  dependencies:',
        '    product: dep-guard',
        '  secrets:',
        '    product: vault-guard',
        '    enforce: false',
        '',
      ].join('\n')
    );
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: '', stderr: 'corpus unreadable', exit: 2 });

    const result = runCli(repo, ['run', '--staged'], bin);

    expect(result.status).toBe(2);
  });
});

describe('a stage-deferred gate beside an unenforced blocking one', () => {
  it('runs neither into the exit code, and says why for each separately', () => {
    // The two mechanisms are different and must stay legible as different
    // ones: the intent gate did not run at all, and the secrets gate ran and
    // was overruled by the policy file.
    const repo = repoWithPolicy(
      [
        'version: 1',
        'gates:',
        '  secrets:',
        '    product: vault-guard',
        '    stage: commit',
        '    enforce: false',
        '  intent:',
        '    product: intent-guard',
        '    stage: ci',
        '',
      ].join('\n')
    );
    const bin = tempDir();
    stubGate(bin, 'vault-guard', {
      stdout: JSON.stringify({
        version: '1',
        summary: { files: 1, secrets: 1 },
        run: { fail_on: 'medium', blocking_matches: 1 },
        results: [
          {
            file: 'src/config.js',
            matches: [
              {
                type: 'github-token',
                severity: 'critical',
                line: 2,
                column: 22,
                offset: 93,
                value: 'ghp_...(40c)',
                fingerprint: '85ce78fecbada885e18040c4ef1299a29367a1d2eec35fec239ab556a0172c79',
              },
            ],
          },
        ],
      }),
      exit: 1,
    });
    // Deliberately not installed: a deferred gate's binary is never looked
    // for, so its absence must not be able to fail this run.
    stubGate(bin, 'dep-guard', { stdout: CLEAN_DEP_GUARD, exit: 0 });

    const result = runCli(repo, ['run', '--staged', '--stage', 'commit'], bin);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/deferred\s+intent/);
    expect(result.stdout).toMatch(/not enforced/);
    expect(result.stdout).toMatch(/vault-guard\/github-token/);
    // Never confused for each other.
    expect(result.stdout).not.toMatch(/conductor\/gate-missing/);
  });

  it('carries both facts into the SARIF log as separate notifications', () => {
    const repo = repoWithPolicy(
      [
        'version: 1',
        'gates:',
        '  secrets:',
        '    product: vault-guard',
        '    enforce: false',
        '  intent:',
        '    product: intent-guard',
        '',
      ].join('\n')
    );
    const bin = tempDir();
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });

    const result = runCli(repo, ['run', '--staged', '--stage', 'commit', '--format', 'sarif'], bin);

    expect(result.status).toBe(0);
    const log = JSON.parse(result.stdout) as {
      runs: Array<{
        tool: { driver: { name: string } };
        invocations?: Array<{
          toolExecutionNotifications: Array<{ descriptor: { id: string } }>;
        }>;
      }>;
    };
    const umbrella = log.runs.find((run) => run.tool.driver.name === 'conductor');
    const ids =
      umbrella?.invocations?.[0].toolExecutionNotifications.map((entry) => entry.descriptor.id) ??
      [];
    expect(ids).toContain('conductor/gate-deferred');
    expect(ids).toContain('conductor/gate-not-enforced');
  });
});

describe('a gate-state reason alongside a budget violation', () => {
  // Both reasons come out of intent-guard in one array with nothing marking
  // which is which. Before the fix the unfrozen-contract reason appeared in
  // neither report.
  const BOTH = JSON.stringify({
    status: 'blocked',
    exitCode: 1,
    reasons: [
      'Intent contract exists but is not frozen by user. Approve and freeze before implementing.',
      'Budget soft_block: Changed 2 files, budget allows 1',
    ],
    contractFound: true,
    contractFrozen: false,
    budget: {
      ok: false,
      action: 'soft_block',
      violations: [
        {
          fingerprint: 'a12fc3e4',
          rule: 'max_files',
          severity: 'soft_block',
          message: 'Changed 2 files, budget allows 1',
          matched: ['a.js', 'b.js'],
        },
      ],
    },
  });

  function intentOnly(): { repo: string; bin: string } {
    const repo = repoWithPolicy(
      'version: 1\ngates:\n  intent:\n    product: intent-guard\n'
    );
    const bin = tempDir();
    stubGate(bin, 'intent-guard', { stdout: BOTH, exit: 1 });
    return { repo, bin };
  }

  it('names both in the text report', () => {
    const { repo, bin } = intentOnly();

    const result = runCli(repo, ['run', '--staged'], bin);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/intent-guard\/budget\.max_files/);
    expect(result.stdout).toMatch(/intent-guard\/gate-blocked/);
    expect(result.stdout).toMatch(/not frozen by user/);
  });

  it('names both in the SARIF log', () => {
    const { repo, bin } = intentOnly();

    const result = runCli(repo, ['run', '--staged', '--format', 'sarif'], bin);

    const log = JSON.parse(result.stdout) as {
      runs: Array<{ results: Array<{ ruleId: string; message: { text: string } }> }>;
    };
    const ruleIds = log.runs.flatMap((run) => run.results.map((entry) => entry.ruleId));
    expect(ruleIds).toContain('intent-guard/budget.max_files');
    expect(ruleIds).toContain('intent-guard/gate-blocked');

    const gateState = log.runs
      .flatMap((run) => run.results)
      .find((entry) => entry.ruleId === 'intent-guard/gate-blocked');
    expect(gateState?.message.text).toMatch(/not frozen by user/);
  });
});

describe('sarif output, continued', () => {
  const DRIFTED = JSON.stringify({
    findings: [null],
    suppressed: 0,
    ignored: 0,
    run: { failOn: 'medium', blockingMatches: 0, diagnostics: [] },
    exitCode: 0,
  });

  it('lists the two gates that ran alongside the umbrella run', () => {
    const repo = repoWithPolicy();
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: DRIFTED, exit: 0 });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
    stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });

    const result = runCli(repo, ['run', '--staged', '--format', 'sarif'], bin);

    expect(result.status).toBe(2);
    const log = JSON.parse(result.stdout) as {
      runs: Array<{ tool: { driver: { name: string } } }>;
    };
    // The gate whose output could not be read produced no tool output, so it
    // gets no run; the two that answered do, and the umbrella's own run
    // carries what it has to say about the third.
    expect(log.runs.map((run) => run.tool.driver.name)).toEqual([
      'vault-guard',
      'intent-guard',
      'conductor',
    ]);
  });
});

describe('conductor run when git cannot answer', () => {
  // Two different failures used to end in the same place: repoRoot caught
  // everything and returned the working directory, so a run from a
  // subdirectory with no git reported "no policy file, run conductor init"
  // about a repository that has one. The generated hook has always named a
  // missing git plainly (src/init.ts); this is the CLI catching up.
  function allThreeStubbed(): string {
    const bin = tempDir();
    stubGate(bin, 'dep-guard', { stdout: CLEAN_DEP_GUARD, exit: 0 });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
    stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });
    return bin;
  }

  it('names the missing git rather than guessing at the working directory', () => {
    // The gates are all installed and the policy file is right there, so
    // nothing else in this run has anything to complain about.
    const result = runCli(repoWithPolicy(), ['run', '--staged'], allThreeStubbed(), {
      git: false,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/git is not on PATH/);
    expect(result.stderr).not.toMatch(STACK_FRAME);
    // Never the diagnosis it used to give, which sent the reader off to
    // install a policy file that already exists.
    expect(result.stderr).not.toMatch(/conductor init/);
    expect(result.stdout).toBe('');
  });

  it('says a directory outside any repository is not one, and names it', () => {
    const outside = tempDir();

    const result = runCli(outside, ['run', '--staged'], allThreeStubbed());

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not a git repository/);
    expect(result.stderr).toContain(outside);
    expect(result.stderr).not.toMatch(STACK_FRAME);
    expect(result.stderr).not.toMatch(/conductor init/);
  });

  it('says git could not be run when the binary is there and will not start', () => {
    // The third branch, which this file first recorded as untestable. It is
    // not: a git that exists and cannot be executed fails the spawn with
    // EACCES, which is neither ENOENT nor an exit code, so neither of the two
    // sentences above is true of it. A file with no execute bit at all is
    // refused for every user, root included, so this does not depend on who
    // the suite runs as.
    const bin = allThreeStubbed();
    const unusable = path.join(bin, 'git');
    writeFileSync(unusable, '#!/bin/sh\nexit 0\n');
    chmodSync(unusable, 0o000);

    // git: false, or runCli would overwrite the file this test just broke.
    const result = runCli(repoWithPolicy(), ['run', '--staged'], bin, { git: false });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/git could not be run/);
    expect(result.stderr).not.toMatch(STACK_FRAME);
    // Not misreported as either of the other two.
    expect(result.stderr).not.toMatch(/not on PATH/);
    expect(result.stderr).not.toMatch(/not a git repository/);
  });
});

describe('the pull_request ambient environment', () => {
  // GitHub Actions sets these three for the WHOLE JOB on a pull_request
  // event, not just for a step that asks for them. This test pollutes the
  // real environment of the process running the suite -- the same thing
  // Actions does to the job hosting this very test -- and then spawns the
  // CLI through runCli, exactly like every other test in this file. If
  // runCli ever goes back to spreading process.env directly instead of
  // going through childEnv(), this is the test that turns red: the intent
  // gate would silently enter its pull-request path, find no contract to
  // check against a scratch repository with no origin, and the run would
  // report 2 gates instead of 3.
  it('does not stop the intent gate from running through a spawned CLI', () => {
    const previous = {
      GITHUB_BASE_REF: process.env.GITHUB_BASE_REF,
      GITHUB_HEAD_REF: process.env.GITHUB_HEAD_REF,
      GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
    };
    process.env.GITHUB_BASE_REF = 'main';
    process.env.GITHUB_HEAD_REF = 'feature/leaky';
    process.env.GITHUB_EVENT_PATH = '/tmp/does-not-exist-pull-request-event.json';

    try {
      const bin = tempDir();
      stubGate(bin, 'dep-guard', { stdout: CLEAN_DEP_GUARD, exit: 0 });
      stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD, exit: 0 });
      stubGate(bin, 'intent-guard', { stdout: CLEAN_INTENT_GUARD, exit: 0 });

      const result = runCli(repoWithPolicy(), ['run', '--staged', '--verbose'], bin);

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^conductor run: 3 gate\(s\)/m);
      expect(result.stdout).not.toMatch(/no contract/);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

/**
 * Pull-request mode, driven through the real CLI against a real repository.
 *
 * The attack is reproduced rather than described. The feature branch does in
 * one commit exactly what the design document says a pull request can do
 * today: it rewrites `.guardrails.yaml` to point the secrets gate's
 * `command:` at a script the same commit adds, and switches the dependency
 * gate off. The script writes a marker file, so "did the attacker's code run"
 * is answered by looking on disk rather than by reading a command line.
 */
describe('pull-request mode through the CLI', () => {
  const BASE_POLICY = [
    'version: 1',
    'gates:',
    '  dependencies:',
    '    product: dep-guard',
    '  secrets:',
    '    product: vault-guard',
    '',
  ].join('\n');

  function git(repo: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
    }
  }

  interface Attack {
    repo: string;
    bin: string;
    marker: string;
  }

  /**
   * A repository whose base branch carries an honest policy and whose head
   * commit carries the rewritten one, plus the script that rewrite points at.
   */
  function attackRepo(options: { headPolicy?: string; basePolicy?: string | null } = {}): Attack {
    const repo = tempDir();
    const bin = tempDir();
    const marker = path.join(tempDir(), 'attacker-ran.txt');

    git(repo, ['init', '--quiet', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);

    stubGate(bin, 'dep-guard', { stdout: CLEAN_DEP_GUARD });
    stubGate(bin, 'vault-guard', { stdout: CLEAN_VAULT_GUARD });

    const basePolicy = options.basePolicy === undefined ? BASE_POLICY : options.basePolicy;
    if (basePolicy !== null) {
      writeFileSync(path.join(repo, '.guardrails.yaml'), basePolicy);
    }
    writeFileSync(path.join(repo, 'app.js'), 'const x = 1;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', 'base']);
    git(repo, ['branch', 'base']);

    // The attacker's own gate: a script the pull request adds, which the
    // pull request's own policy file points the secrets gate at. It prints
    // clean JSON so a run that obeys it looks like a run that found nothing.
    const attacker = path.join(repo, 'tools', 'nice-gate.sh');
    mkdirSync(path.dirname(attacker), { recursive: true });
    writeFileSync(
      attacker,
      [
        '#!/bin/sh',
        `printf 'ran\\n' > ${JSON.stringify(marker)}`,
        `echo ${JSON.stringify(CLEAN_VAULT_GUARD)}`,
        'exit 0',
      ].join('\n') + '\n'
    );
    chmodSync(attacker, 0o755);

    const headPolicy =
      options.headPolicy ??
      [
        'version: 1',
        'gates:',
        '  dependencies:',
        '    product: dep-guard',
        '    enabled: false',
        '  secrets:',
        '    product: vault-guard',
        `    command: ${attacker}`,
        '    args: []',
        '',
      ].join('\n');
    writeFileSync(path.join(repo, '.guardrails.yaml'), headPolicy);
    writeFileSync(path.join(repo, 'app.js'), 'const x = 2;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', 'the pull request']);

    return { repo, bin, marker };
  }

  it('runs the attacker script when there is no trust base, which is the hole', () => {
    // The before half of the reproduction. Without this the after half proves
    // only that a script did not run, which is also true of a script that was
    // never runnable.
    const { repo, bin, marker } = attackRepo();

    const result = runCli(repo, ['run', '--staged'], bin);

    expect(existsSync(marker)).toBe(true);
    expect(result.stdout).not.toMatch(/dep-guard/);
  });

  it('takes the policy from the base ref, so the attacker script never runs', () => {
    const { repo, bin, marker } = attackRepo();

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'base', '--verbose'], bin);

    expect(existsSync(marker)).toBe(false);
    // The base policy's own gates ran, including the one the head disabled.
    expect(result.stdout).toMatch(/dependencies\s+dep-guard/);
    expect(result.stdout).toMatch(/secrets\s+vault-guard/);
    expect(result.stdout).toMatch(/policy changed in this pull request/);
  });

  it('reports the policy change on the one-line summary of a clean run', () => {
    const { repo, bin } = attackRepo();

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'base'], bin);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/1 control change\(s\) proposed in this pull request\./);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
  });

  it('reports a proposal when only an option changed, with no gate added or removed', () => {
    const { repo, bin } = attackRepo({
      headPolicy: [
        'version: 1',
        'gates:',
        '  dependencies:',
        '    product: dep-guard',
        '  secrets:',
        '    product: vault-guard',
        '    options:',
        '      fail-on: none',
        '',
      ].join('\n'),
    });

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'base'], bin);

    expect(result.stdout).toMatch(/1 control change\(s\) proposed in this pull request\./);
  });

  it('reports no proposal when the head policy only differs in formatting', () => {
    const { repo, bin } = attackRepo({
      headPolicy:
        '# a comment the base did not have\n' +
        "version: 1\ngates: { dependencies: { product: 'dep-guard' }, secrets: { product: vault-guard } }\n",
    });

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'base'], bin);

    expect(result.stdout).toMatch(/0 control change\(s\) proposed in this pull request\./);
  });

  it('fails closed on a base ref that does not resolve: every enabled gate, exit 2', () => {
    const { repo, bin, marker } = attackRepo();

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'origin/nope'], bin);

    expect(result.status).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(result.stdout).toMatch(/does not resolve to a commit/);
    expect(result.stdout).toMatch(/origin\/nope/);
    // Both gates the head policy names are reported as not having run. The
    // head's file is an inventory here and nothing else: it cannot lower the
    // exit code, and enabled: false on the dependency gate in it is why only
    // the secrets gate would be named if it could.
    expect(result.stdout).toMatch(/DID NOT RUN \(preparation-failed\)/);
    expect(result.stdout).toMatch(/verdict: exit 2/);
  });

  it('still reports the refusal when the head policy enables no gate at all', () => {
    // The shape that made the old report lie. The head's file is the only
    // inventory available when the base ref cannot be read, and a head that
    // switches every gate off leaves it empty, so the report had nothing to
    // count and printed "verdict: exit 0, no gate ran because none is
    // enabled" while the process exited 2 and nothing had been checked. This
    // is reachable on the DEFAULT actions/checkout, which fetches depth 1.
    const { repo, bin } = attackRepo({
      headPolicy: [
        'version: 1',
        'gates:',
        '  secrets:',
        '    product: vault-guard',
        '    enabled: false',
        '',
      ].join('\n'),
    });

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'origin/nope'], bin);

    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/^conductor: refused the trust base "origin\/nope"/m);
    expect(result.stdout).toMatch(/does not resolve to a commit/);
    expect(result.stdout).toMatch(/fetch-depth: 0/);
    expect(result.stdout).toMatch(/verdict: exit 2/);
    expect(result.stdout).not.toMatch(/Set enabled: true/);
  });

  it('writes a SARIF log with the refusal even when the head policy enables no gate', () => {
    // The same shape in the other format, where it was worse: an empty
    // {"runs": []} uploads cleanly and is indistinguishable from a scan of a
    // repository nobody gated.
    const { repo, bin } = attackRepo({
      headPolicy: [
        'version: 1',
        'gates:',
        '  secrets:',
        '    product: vault-guard',
        '    enabled: false',
        '',
      ].join('\n'),
    });

    const result = runCli(
      repo,
      ['run', '--staged', '--trust-base', 'origin/nope', '--format', 'sarif'],
      bin
    );
    const log = JSON.parse(result.stdout) as {
      runs: Array<{
        invocations?: Array<{
          executionSuccessful?: boolean;
          toolExecutionNotifications?: Array<{ descriptor: { id: string }; level: string }>;
        }>;
      }>;
    };

    expect(result.status).toBe(2);
    expect(log.runs).toHaveLength(1);
    const invocation = log.runs[0].invocations?.[0];
    expect(invocation?.executionSuccessful).toBe(false);
    const refusal = (invocation?.toolExecutionNotifications ?? []).find(
      (entry) => entry.descriptor.id === 'conductor/trust-base-refused'
    );
    expect(refusal?.level).toBe('error');
  });

  it('reports the refusal when the head policy will not parse at all', () => {
    // The other way to an empty inventory: loadPolicy throws, the inventory
    // falls back to no gates, and the refusal is still the whole story.
    const { repo, bin } = attackRepo({ headPolicy: 'version: 1\ngates: nonsense\n' });

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'origin/nope'], bin);

    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/refused the trust base/);
    // The refusal, not a policy-parse error: the ref is what went wrong, and
    // reporting the head's malformed file would send the reader to the wrong
    // fix on a run that would have ignored that file anyway.
    expect(result.stderr).not.toMatch(/not a valid policy file/);
  });

  it('refuses a trust base that is the head commit', () => {
    const { repo, bin } = attackRepo();

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'HEAD'], bin);

    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/the same commit as HEAD/);
  });

  it('exits could-not-run (2) when the base ref carries no policy, with the reason IN the text report', () => {
    // The false-safe this pins against: a fresh adopter's first pull request,
    // before "conductor init" has ever landed on the base branch. Two real
    // consumer teams hit exactly this running conductor in advisory mode.
    // Nothing may have run and the exit code says could-not-run, but until
    // this test the ONLY place that said why was stderr -- a plain "conductor:
    // <message>" line -- and stdout, which is what a --format text report
    // and a pull request comment both read from, was completely empty. A
    // reader saw a red step and an unhelpful blank report and had no way to
    // tell a genuinely broken run from an adoption gap.
    const { repo, bin, marker } = attackRepo({ basePolicy: null });

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'base'], bin);

    expect(result.status).toBe(2);
    expect(existsSync(marker)).toBe(false);
    // The reason is now IN THE TEXT REPORT (stdout), which is what a
    // --format text run and the pull-request-comment step both read.
    expect(result.stdout).toMatch(/No \.guardrails\.yaml on "base"/);
    expect(result.stdout).toMatch(/is a proposal/);
    expect(result.stdout).toMatch(/once it is on the base branch/);
    // The verdict says could-not-run, never clean, and the word "clean"
    // does not appear anywhere on a run that checked nothing.
    expect(result.stdout).toMatch(/verdict: exit 2/);
    expect(result.stdout).not.toMatch(/clean/);
    // The head's own gates are named as not having run, exactly like the
    // ref-unresolvable refusal above: this is the same could-not-run family,
    // and the report follows the same shape rather than inventing a second
    // one for "the ref resolved but carried no file".
    expect(result.stdout).toMatch(/DID NOT RUN \(preparation-failed\)/);
  });

  it('stays a clean exit 0 when the base policy exists but the user switched every gate off', () => {
    // The judgment call this PR has to make explicit: CONFIG ABSENT on the
    // base (nobody has finished setup yet, a discovered-empty) is
    // could-not-run, per the test above. CONFIG PRESENT but every gate
    // switched off is a different state -- somebody wrote that file down on
    // the base branch, on purpose -- and it stays the ordinary "0 gate(s)
    // enabled" clean exit 0 this codebase already gives a policy file with
    // enabled: false everywhere. This mirrors the no-contract (write one) vs
    // contract-waived (a person already decided) distinction the intent gate
    // already makes for a missing spec; see run.ts's SkippedGate and
    // output-text.ts's skipWording. Pinned here so a future change cannot
    // silently fold this case into could-not-run without a reviewer noticing
    // the test that says it should not be.
    const { repo, bin } = attackRepo({
      basePolicy: [
        'version: 1',
        'gates:',
        '  dependencies:',
        '    product: dep-guard',
        '    enabled: false',
        '  secrets:',
        '    product: vault-guard',
        '    enabled: false',
        '',
      ].join('\n'),
    });

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'base'], bin);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/verdict: exit 0, no gate ran because none is enabled/);
  });

  it('runs from the base policy even when the head deleted the policy file', () => {
    const { repo, bin } = attackRepo({
      headPolicy: 'version: 1\ngates:\n  secrets:\n    product: vault-guard\n',
    });
    // The working tree has none at all, which is the state a pull request
    // that deletes the file leaves behind on a checkout of its own head.
    rmSync(path.join(repo, '.guardrails.yaml'));

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'base'], bin);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/2 gate\(s\) ran/);
  });

  it('refuses a policy key that would write the trust-base flag a second time', () => {
    const { repo, bin } = attackRepo({
      basePolicy: [
        'version: 1',
        'gates:',
        '  intent:',
        '    product: intent-guard',
        '    options:',
        '      trust-base: HEAD',
        '',
      ].join('\n'),
      headPolicy: 'version: 1\ngates:\n  secrets:\n    product: vault-guard\n',
    });

    const result = runCli(repo, ['run', '--staged', '--trust-base', 'base'], bin);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/"trust-base" under gates\.intent\.options is reserved/);
    expect(result.stderr).toMatch(/where a gate reads its rules from/);
  });
});

/**
 * The program that judges the pull request, not only the rules it judges by.
 *
 * Reading the rules from the base ref is worth nothing if the pull request
 * chooses the binary that applies them, and it can, two ways that both look
 * ordinary in a diff.
 *
 * The first is a base policy whose `command:` points INSIDE the repository,
 * at something like `vendor/vault-guard`. The path came from the base and is
 * approved; the file at that path is whatever the head put there.
 *
 * The second needs no policy change at all. Resolution prefers the
 * repository's own `node_modules/.bin` over PATH, deliberately, so a project
 * pin beats a global install. A head that commits `node_modules/.bin/<gate>`
 * shadows the real gate, and a stub answering `--version` with a plausible
 * number passes every other check. The composite action installs nothing, so
 * the plant survives the install step.
 *
 * Both are driven here as real repositories with real git history, and the
 * planted program writes a marker file, so "did the pull request's own
 * program run" is answered by looking on disk.
 */
describe('the program a pull-request run is allowed to execute', () => {
  function git(repo: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
    }
  }

  const CLEAN_SECRETS = CLEAN_VAULT_GUARD;

  /**
   * A repository whose base branch is honest and whose head may plant a
   * program at `programPath`.
   *
   * Everything is decided by the two commits this makes and nothing is
   * committed afterwards, so a test never has to move the base branch and
   * cannot accidentally move the plant into the base with it. `baseBody` is
   * what that file IS at the BASE and `headBody` what it is at the head:
   * `honest` reports nothing and touches nothing, `plant` writes the marker
   * and reports clean, and null means the file is not at that ref at all,
   * which is how the node_modules shape is expressed.
   */
  function plantedRepo(options: {
    programPath: string;
    baseBody: 'honest' | 'plant' | null;
    headBody: 'honest' | 'plant' | null;
    /** Repository-relative path for the policy's `command:`, or null. */
    commandRelative?: string | null;
    enforce?: boolean;
  }): { repo: string; bin: string; marker: string; program: string } {
    const repo = tempDir();
    const bin = tempDir();
    const marker = path.join(tempDir(), 'planted-ran.txt');

    git(repo, ['init', '--quiet', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);

    // The real gate, on PATH and outside the repository. It reports the
    // secret the pull request carries.
    stubGate(bin, 'vault-guard', {
      stdout: JSON.stringify({
        version: '1',
        scannedAt: '2026-09-06T00:00:00.000Z',
        summary: { files: 1, secrets: 1 },
        run: { files_scanned: 1, patterns_active: 59, fail_on: 'medium', blocking_matches: 1 },
        results: [
          {
            file: 'leak.js',
            matches: [
              {
                type: 'github-token',
                severity: 'critical',
                line: 1,
                column: 15,
                offset: 15,
                value: 'ghp_...',
                fingerprint: 'abc123',
              },
            ],
          },
        ],
      }),
      exit: 1,
      version: '1.7.0',
    });

    const program = path.join(repo, options.programPath);
    const policy = [
      'version: 1',
      'gates:',
      '  secrets:',
      '    product: vault-guard',
      '    enabled: true',
      ...(options.enforce === false ? ['    enforce: false'] : []),
      ...(options.commandRelative === undefined || options.commandRelative === null
        ? []
        : [`    command: ${path.join(repo, options.commandRelative)}`, '    args: []']),
      '',
    ].join('\n');

    const stub = (body: string): string =>
      ['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "1.7.0"; exit 0; fi', body, 'exit 0'].join(
        '\n'
      ) + '\n';

    function writeProgram(kind: 'honest' | 'plant'): void {
      const body =
        kind === 'honest'
          ? `echo ${JSON.stringify(CLEAN_SECRETS)}`
          : `printf 'ran\\n' > ${JSON.stringify(marker)}\necho ${JSON.stringify(CLEAN_SECRETS)}`;
      mkdirSync(path.dirname(program), { recursive: true });
      writeFileSync(program, stub(body));
      chmodSync(program, 0o755);
    }

    writeFileSync(path.join(repo, '.guardrails.yaml'), policy);
    writeFileSync(path.join(repo, 'app.js'), 'const x = 1;\n');
    if (options.baseBody !== null) {
      writeProgram(options.baseBody);
    }
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', 'base']);
    git(repo, ['branch', 'base']);

    // The pull request: a secret, and, when asked for, a program that says
    // there is none.
    writeFileSync(
      path.join(repo, 'leak.js'),
      "const token = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';\n"
    );
    if (options.headBody !== null) {
      writeProgram(options.headBody);
    }
    // --force so a node_modules path is TRACKED at the head. That is the
    // strongest form of the attack: it survives a clone, and the rule still
    // has to refuse it, because being tracked at the head is not the same as
    // being approved by the base.
    git(repo, ['add', '-A', '--force']);
    git(repo, ['commit', '--quiet', '-m', 'the pull request']);

    return { repo, bin, marker, program };
  }

  describe('a base command: pointing at a file the head replaced', () => {
    /** The base approves the path AND the bytes; the head changes the bytes. */
    const replaced = () =>
      plantedRepo({
        programPath: 'vendor/vault-guard',
        commandRelative: 'vendor/vault-guard',
        baseBody: 'honest',
        headBody: 'plant',
      });

    it('runs the head replacement when there is no trust base, which is the hole', () => {
      const { repo, bin, marker } = replaced();

      const result = runCli(repo, ['run'], bin);

      expect(existsSync(marker)).toBe(true);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/vault-guard\/github-token/);
    });

    it('refuses to run it under a trust base, naming the path and why', () => {
      const { repo, bin, marker } = replaced();

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(existsSync(marker)).toBe(false);
      expect(result.status).toBe(2);
      expect(result.stdout).toMatch(/DID NOT RUN \(gate-program-refused\)/);
      expect(result.stdout).toMatch(/vendor\/vault-guard is not the one "base" approved/);
    });

    it('accepts a vendored program the pull request did not touch', () => {
      // The other direction, and it is what keeps the rule usable rather than
      // a blanket ban on vendoring: a committed gate that is byte for byte
      // what the base approved is exactly as trustworthy as the base ref.
      const { repo, bin } = plantedRepo({
        programPath: 'vendor/vault-guard',
        commandRelative: 'vendor/vault-guard',
        baseBody: 'honest',
        headBody: 'honest',
      });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(result.stdout).not.toMatch(/gate-program-refused/);
      expect(result.stdout).toMatch(/secrets\s+vault-guard/);
    });

    it('accepts a program on PATH, which a pull request cannot write', () => {
      const { repo, bin } = plantedRepo({
        programPath: 'vendor/unused',
        commandRelative: null,
        baseBody: null,
        headBody: null,
      });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(result.stdout).not.toMatch(/gate-program-refused/);
      // And the real gate on PATH reported the secret the pull request added.
      expect(result.stdout).toMatch(/vault-guard\/github-token/);
    });
  });

  /**
   * The wrapper shape: the program is approved, what it calls is not.
   *
   * A vendored gate is rarely one file. `vendor/vault-guard` is a wrapper
   * that execs `vendor/impl.sh`, and a pull request that leaves the wrapper
   * byte for byte alone and rewrites the helper beside it passes a check that
   * only looks at the program file. Nothing in the diff touches the path the
   * policy names.
   *
   * So the unit of approval is the program's DIRECTORY, not the program: the
   * tree object id of the containing directory must be identical at the trust
   * base and at the head, which covers every file in that subtree at once
   * without the umbrella having to know what a wrapper calls.
   */
  describe('a base-approved wrapper whose helper the head replaced', () => {
    /**
     * A repository with a two-file vendored gate.
     *
     * `vendor/vault-guard` is the wrapper the policy names and is identical
     * at both refs. `vendor/impl.sh` is what it execs; `headHelper` decides
     * what the head puts there. `elsewhere` changes an unrelated file, which
     * must not refuse anything.
     */
    function wrapperRepo(options: {
      headHelper: 'honest' | 'plant';
      elsewhere?: boolean;
      atRoot?: boolean;
    }): { repo: string; bin: string; marker: string } {
      const repo = tempDir();
      const bin = tempDir();
      const marker = path.join(tempDir(), 'planted-ran.txt');

      git(repo, ['init', '--quiet', '-b', 'main']);
      git(repo, ['config', 'user.email', 'test@example.com']);
      git(repo, ['config', 'user.name', 'Test']);

      stubGate(bin, 'vault-guard', {
        stdout: JSON.stringify({
          version: '1',
          scannedAt: '2026-09-06T00:00:00.000Z',
          summary: { files: 1, secrets: 1 },
          run: { files_scanned: 1, patterns_active: 59, fail_on: 'medium', blocking_matches: 1 },
          results: [
            {
              file: 'leak.js',
              matches: [
                {
                  type: 'github-token',
                  severity: 'critical',
                  line: 1,
                  column: 15,
                  offset: 15,
                  value: 'ghp_...',
                  fingerprint: 'abc123',
                },
              ],
            },
          ],
        }),
        exit: 1,
        version: '1.7.0',
      });

      const dir = options.atRoot === true ? repo : path.join(repo, 'vendor');
      const wrapper = path.join(dir, 'vault-guard');
      const helper = path.join(dir, 'impl.sh');
      mkdirSync(dir, { recursive: true });

      // The wrapper never changes. It is what the policy names, and its bytes
      // are identical at both refs, which is exactly what makes this shape
      // invisible to a per-file check.
      writeFileSync(
        wrapper,
        `#!/bin/sh\nexec ${JSON.stringify(helper)} "$@"\n`
      );
      chmodSync(wrapper, 0o755);

      const helperBody = (kind: 'honest' | 'plant'): string =>
        [
          '#!/bin/sh',
          'if [ "$1" = "--version" ]; then echo "1.7.0"; exit 0; fi',
          ...(kind === 'plant' ? [`printf 'ran\\n' > ${JSON.stringify(marker)}`] : []),
          `echo ${JSON.stringify(CLEAN_VAULT_GUARD)}`,
          'exit 0',
        ].join('\n') + '\n';

      writeFileSync(helper, helperBody('honest'));
      chmodSync(helper, 0o755);
      writeFileSync(
        path.join(repo, '.guardrails.yaml'),
        [
          'version: 1',
          'gates:',
          '  secrets:',
          '    product: vault-guard',
          `    command: ${wrapper}`,
          '    args: []',
          '',
        ].join('\n')
      );
      writeFileSync(path.join(repo, 'app.js'), 'const x = 1;\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', 'base: a vendored gate in its own directory']);
      git(repo, ['branch', 'base']);

      writeFileSync(
        path.join(repo, 'leak.js'),
        "const token = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';\n"
      );
      if (options.headHelper === 'plant') {
        writeFileSync(helper, helperBody('plant'));
        chmodSync(helper, 0o755);
      }
      if (options.elsewhere === true) {
        writeFileSync(path.join(repo, 'app.js'), 'const x = 2;\n');
      }
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', 'the pull request']);

      return { repo, bin, marker };
    }

    it('runs the replaced helper when there is no trust base, which is the hole', () => {
      const { repo, bin, marker } = wrapperRepo({ headHelper: 'plant' });

      const result = runCli(repo, ['run'], bin);

      expect(existsSync(marker)).toBe(true);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/vault-guard\/github-token/);
    });

    it('refuses under a trust base, naming the directory and the file beside it', () => {
      const { repo, bin, marker } = wrapperRepo({ headHelper: 'plant' });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(existsSync(marker)).toBe(false);
      expect(result.status).toBe(2);
      expect(result.stdout).toMatch(/DID NOT RUN \(gate-program-refused\)/);
      expect(result.stdout).toMatch(/a file beside the gate program in vendor/);
    });

    it('accepts a vendored directory the pull request left entirely alone', () => {
      // The direction that keeps the rule usable. A gate vendored into its
      // own directory and untouched is exactly as trustworthy as the base.
      const { repo, bin } = wrapperRepo({ headHelper: 'honest' });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(result.stdout).not.toMatch(/gate-program-refused/);
      expect(result.stdout).toMatch(/secrets\s+vault-guard/);
    });

    it('does not refuse over a change elsewhere in the repository', () => {
      // The rule is the program's DIRECTORY, not the whole tree. Comparing
      // root trees would refuse every pull request that changed any file,
      // which is every pull request.
      const { repo, bin } = wrapperRepo({ headHelper: 'honest', elsewhere: true });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(result.stdout).not.toMatch(/gate-program-refused/);
      expect(result.stdout).toMatch(/secrets\s+vault-guard/);
    });

    it('refuses a program at the repository root and says to give it a directory', () => {
      // At the root the containing directory IS the whole repository, so the
      // comparison is the root tree and any pull request at all differs from
      // its base. Refusing with the remedy beats a rule that silently means
      // "no pull request may change anything".
      const { repo, bin } = wrapperRepo({ headHelper: 'honest', atRoot: true });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(result.status).toBe(2);
      expect(result.stdout).toMatch(/DID NOT RUN \(gate-program-refused\)/);
      expect(result.stdout).toMatch(/at the repository root/);
      expect(result.stdout).toMatch(/its own directory/);
    });
  });

  describe('a head-committed node_modules/.bin stub, with no command: at all', () => {
    it('shadows the real gate when there is no trust base, which is the hole', () => {
      const { repo, bin, marker } = plantedRepo({
        programPath: 'node_modules/.bin/vault-guard',
        baseBody: null,
        headBody: 'plant',
      });

      const result = runCli(repo, ['run'], bin);

      // The repository's own copy beats PATH, deliberately, so the plant wins
      // and answers clean with a plausible version.
      expect(existsSync(marker)).toBe(true);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/vault-guard\/github-token/);
    });

    it('never reaches it under a trust base, and the gate on PATH reports what it hid', () => {
      // 0.3.0 let resolution take the plant and then refused the program,
      // which was safe and turned every ordinary pull request in a
      // devDependency-installed repository into three refusals and exit 2.
      // 0.4.0 does not try that location at all, so the same plant is
      // unreachable AND the real gate still runs, off PATH.
      const { repo, bin, marker } = plantedRepo({
        programPath: 'node_modules/.bin/vault-guard',
        baseBody: null,
        headBody: 'plant',
      });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(existsSync(marker)).toBe(false);
      expect(result.stdout).not.toMatch(/gate-program-refused/);
      // The secret the plant existed to hide, found by the gate on PATH.
      expect(result.stdout).toMatch(/vault-guard\/github-token/);
      expect(result.status).toBe(1);
      // And the skip is not silent: the one line that says where the program
      // came from names the copy that was not taken.
      expect(result.stdout).toMatch(/node_modules\/\.bin not consulted/);
      expect(result.stdout).toMatch(/node_modules\/\.bin\/vault-guard/);
    });

    it('is could-not-run with the install remedy when there is no gate on PATH either', () => {
      // The repository shape this change exists for: the gates are
      // devDependencies and nothing else. The gate does not run, which is
      // right, and the message says what to do rather than leaving a reader
      // looking at a node_modules/.bin/vault-guard they were just told does
      // not exist.
      const { repo, marker } = plantedRepo({
        programPath: 'node_modules/.bin/vault-guard',
        baseBody: null,
        headBody: 'plant',
      });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], tempDir());

      expect(existsSync(marker)).toBe(false);
      expect(result.status).toBe(2);
      expect(result.stdout).toMatch(/DID NOT RUN \(binary-missing\)/);
      expect(result.stdout).toMatch(/npm install -g @vaultcompass\/vault-guard/);
      expect(result.stdout).toMatch(/vault-guard-version/);
    });

    it('never asks the planted program for its version, since the probe runs it', () => {
      // The probe RUNS the binary. Checking provenance after it would already
      // have executed the plant, and a stub answering "1.7.0" is the cheapest
      // version of this attack.
      const { repo, bin, marker, program } = plantedRepo({
        programPath: 'node_modules/.bin/vault-guard',
        baseBody: null,
        headBody: 'plant',
      });
      // A plant that writes the marker on EVERY invocation, --version
      // included. Left uncommitted on purpose: the file git records is
      // irrelevant here, what matters is that nothing executes this one.
      writeFileSync(
        program,
        `#!/bin/sh\nprintf 'ran\\n' > ${JSON.stringify(marker)}\nif [ "$1" = "--version" ]; then echo "1.7.0"; exit 0; fi\necho ${JSON.stringify(CLEAN_SECRETS)}\nexit 0\n`
      );
      chmodSync(program, 0o755);

      runCli(repo, ['run', '--trust-base', 'base'], bin);

      expect(existsSync(marker)).toBe(false);
    });

    it('is exit 2 even when the policy says that gate is not enforced', () => {
      // enforce: false is a standing decision about what a gate's FINDINGS
      // are worth, and this gate produced none: the umbrella refused to run a
      // program the pull request chose. Letting an unenforced gate swallow
      // that would let a pull request pick its own judge and stay green.
      // enforce: false is written at the BASE, so it is the trusted policy's
      // own standing decision rather than something the head asked for.
      //
      // Driven through a vendored program the head replaced rather than
      // through a node_modules plant: since 0.4.0 that location is not
      // consulted at all on a pull-request run, so it no longer reaches the
      // program refusal this is about. The invariant is unchanged and the
      // shape that still reaches it is the in-repo one.
      const { repo, bin } = plantedRepo({
        programPath: 'vendor/vault-guard',
        commandRelative: 'vendor/vault-guard',
        baseBody: 'honest',
        headBody: 'plant',
        enforce: false,
      });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(result.status).toBe(2);
      expect(result.stdout).toMatch(/DID NOT RUN \(gate-program-refused\)/);
    });

    it('raises a conductor/gate-program-refused notification at error level', () => {
      // Same retarget as the enforcement case above, and for the same reason:
      // the node_modules shape is now unreachable, and the in-repo one is
      // what still exercises the refusal this notification is about.
      const { repo, bin } = plantedRepo({
        programPath: 'vendor/vault-guard',
        commandRelative: 'vendor/vault-guard',
        baseBody: 'honest',
        headBody: 'plant',
      });

      const result = runCli(repo, ['run', '--trust-base', 'base', '--format', 'sarif'], bin);
      const log = JSON.parse(result.stdout) as {
        runs: Array<{
          invocations?: Array<{
            toolExecutionNotifications?: Array<{
              descriptor: { id: string };
              level: string;
              properties: { details: Record<string, unknown> };
            }>;
          }>;
        }>;
      };

      const refusal = log.runs
        .flatMap((run) => run.invocations ?? [])
        .flatMap((invocation) => invocation.toolExecutionNotifications ?? [])
        .find((entry) => entry.descriptor.id === 'conductor/gate-program-refused');

      expect(refusal?.level).toBe('error');
      expect(refusal?.properties.details.product).toBe('vault-guard');
      expect(String(refusal?.properties.details.program)).toMatch(/vendor\/vault-guard/);
    });

    it('refuses an in-repo symlink on its own entry, before the target matters', () => {
      // A symlink in the repository never gets as far as its target being
      // interesting: its own tree entry is either untracked, as here, or a
      // mode of 120000 rather than a regular file, and either refuses. The
      // target IS also vetted when it is in the repository, which is what
      // catches a link that lives outside the tree and points in; it just
      // never decides this case.
      const { repo, bin, marker, program } = plantedRepo({
        programPath: 'vendor/real-gate',
        commandRelative: 'node_modules/.bin/vault-guard',
        baseBody: 'honest',
        headBody: 'plant',
      });
      const link = path.join(repo, 'node_modules', '.bin', 'vault-guard');
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(program, link);

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      expect(existsSync(marker)).toBe(false);
      expect(result.status).toBe(2);
      expect(result.stdout).toMatch(
        /does not track the gate program at node_modules\/\.bin\/vault-guard/
      );
    });

    it("vets the link's own entry even where the tree root is reached through a symlink", () => {
      // The bug this pins. The repository root arrives realpath'd, and the
      // program path did not, so on a machine whose working tree sits under a
      // symlinked mount the link's own spelling compared as OUTSIDE the tree
      // and was skipped silently. Only the target was vetted, and a link
      // whose target was fine sailed through. Asserted as a property of the
      // refusal rather than of the path: the LINK is what is named.
      const { repo, bin, program } = plantedRepo({
        programPath: 'vendor/real-gate',
        commandRelative: 'node_modules/.bin/vault-guard',
        baseBody: 'honest',
        headBody: 'honest',
      });
      const link = path.join(repo, 'node_modules', '.bin', 'vault-guard');
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(program, link);

      const result = runCli(repo, ['run', '--trust-base', 'base', '--verbose'], bin);

      // The target is unchanged between base and head, so vetting only the
      // target accepts this. The link is untracked, so vetting the link
      // refuses it.
      expect(result.status).toBe(2);
      expect(result.stdout).toMatch(/node_modules\/\.bin\/vault-guard/);
    });

    it('changes nothing outside pull-request mode', () => {
      // A local run on your own checkout is already inside the trust
      // boundary, and a developer with a vendored or pinned gate must not
      // start seeing refusals over it.
      const { repo, bin, marker } = plantedRepo({
        programPath: 'node_modules/.bin/vault-guard',
        baseBody: null,
        headBody: 'plant',
      });

      const result = runCli(repo, ['run'], bin);

      expect(existsSync(marker)).toBe(true);
      expect(result.stdout).not.toMatch(/gate-program-refused/);
    });
  });
});

/**
 * intent-guard's refused state directory, which is exit 1 with no JSON.
 *
 * The gate raises StateDirError for a `.intent-guard` that is a symlink, and
 * its own convention prints one line and exits 1 rather than 2, because 2 is
 * reserved there for a config or a ref it could not read. From the umbrella's
 * side that is a gate which "exited 1 with nothing parseable on stdout",
 * which is the reliable signature of a rejected configuration and must be
 * classified as COULD-NOT-RUN. Reading it as a blocked gate would tell a user
 * their code drifted from a contract nobody read.
 */
describe('a gate that refuses its own state directory', () => {
  const SYMLINK_REFUSAL =
    'Intent Guard needs .intent-guard to be a real directory, but it is a symlink. ' +
    'Replace the link with a real directory.';

  it('is could-not-run and exit 2, never a drift verdict', () => {
    const repo = repoWithPolicy(
      ['version: 1', 'gates:', '  intent:', '    product: intent-guard', ''].join('\n')
    );
    const bin = tempDir();
    stubGate(bin, 'intent-guard', { stdout: '', stderr: SYMLINK_REFUSAL, exit: 1 });

    const result = runCli(repo, ['run', '--staged'], bin);

    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/DID NOT RUN \(unparseable-output\)/);
    expect(result.stdout).toMatch(/conductor\/gate-output-unparseable/);
    // The gate's own sentence survives into the report, which is the only
    // place a reader learns the fix is on disk rather than in their diff.
    expect(result.stdout).toMatch(/it is a symlink/);
    expect(result.stdout).not.toMatch(/drift/);
  });
});
