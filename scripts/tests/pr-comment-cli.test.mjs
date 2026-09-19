// The `pr-comment.mjs` CLI wrapper the action's composite step invokes:
// `node "$ACTION_PATH/scripts/pr-comment.mjs" --report <file> --pr <n> --repo
// <owner/repo>`.
//
// Run for real here, as a subprocess, with `gh` replaced by a recording shim
// on PATH -- the same device `tests/action.test.ts` uses for `npm` in the
// install step. That is what proves the WIRING (argv parsing, the report
// read from disk, the exit code) rather than only the pure logic
// `pr-comment.test.mjs` already covers. Nothing here reaches a real network:
// the shim never does anything but record its own argv and answer with a
// canned response or a non-zero exit.

import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pr-comment.mjs',
);

const { parseArgs } = await import('../pr-comment.mjs');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'conductor-pr-comment-cli-'));
  tempDirs.push(dir);
  return dir;
}

describe('parseArgs', () => {
  it('reads --report, --pr and --repo', () => {
    expect(parseArgs(['--report', 'r.txt', '--pr', '42', '--repo', 'acme/widgets'])).toEqual({
      report: 'r.txt',
      pr: '42',
      repo: 'acme/widgets',
      marker: undefined,
    });
  });

  it('leaves missing flags null rather than throwing', () => {
    expect(parseArgs([])).toEqual({ report: null, pr: null, repo: null, marker: undefined });
  });
});

/**
 * A `gh` shim on PATH that records every invocation's argv and, for `api`
 * calls, answers from a canned response queue -- or exits non-zero, to
 * reproduce a fork pull request's read-only token.
 */
function ghShim(dir, { listResponse = '[]', createResponse = '{"id":99}', failOn = null } = {}) {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const record = path.join(dir, 'gh-argv.jsonl');
  writeFileSync(record, '');
  const shim = path.join(bin, 'gh');
  writeFileSync(
    shim,
    '#!/usr/bin/env node\n' +
      'const fs = require("node:fs");\n' +
      `const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + "\\n");\n` +
      `const failOn = ${JSON.stringify(failOn)};\n` +
      'if (failOn && args.join(" ").includes(failOn)) {\n' +
      '  process.stderr.write("HTTP 403: Resource not accessible by integration\\n");\n' +
      '  process.exit(1);\n' +
      '}\n' +
      'if (args.includes("--paginate")) {\n' +
      `  process.stdout.write(${JSON.stringify(listResponse)});\n` +
      '} else {\n' +
      `  process.stdout.write(${JSON.stringify(createResponse)});\n` +
      '}\n',
  );
  chmodSync(shim, 0o755);
  return { bin, record };
}

function readArgv(record) {
  return readFileSync(record, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runCli(args, { bin, extraEnv = {} } = {}) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('the pr-comment CLI', () => {
  it('reads the report from disk and posts it by file, with the marker, and exits 0', () => {
    const dir = tempDir();
    const { bin, record } = ghShim(dir);
    const reportFile = path.join(dir, 'conductor.txt');
    writeFileSync(reportFile, 'conductor: clean, nothing blocked. 2 gate(s) ran.');

    const run = runCli(['--report', reportFile, '--pr', '42', '--repo', 'acme/widgets'], { bin });

    expect(run.status).toBe(0);
    const argv = readArgv(record);
    expect(argv).toHaveLength(2);
    expect(argv[0]).toEqual(['api', 'repos/acme/widgets/issues/42/comments', '--paginate']);
    expect(argv[1][0]).toBe('api');
    expect(argv[1][1]).toBe('repos/acme/widgets/issues/42/comments');
    // -F/--field, never -f/--raw-field: gh's `@<path>` file-read form only
    // works with -F. -f would send the literal string "body=@<path>" as the
    // comment body instead of reading the file.
    expect(argv[1][2]).toBe('-F');
    // The body arrives at gh as an @-file reference, never as the report text
    // itself: no element of the argument vector carries the report.
    expect(argv[1][3]).toMatch(/^body=@/);
    for (const call of argv) {
      for (const arg of call) {
        expect(arg).not.toContain('clean, nothing blocked');
      }
    }
    const bodyFile = argv[1][3].slice('body=@'.length);
    const body = readFileSync(bodyFile, 'utf8');
    expect(body.indexOf('<!-- conductor-report: pr-comment -->')).toBe(0);
    expect(body).toContain('conductor: clean, nothing blocked. 2 gate(s) ran.');
  });

  it('updates the existing marked comment instead of creating a second one', () => {
    const dir = tempDir();
    const { bin, record } = ghShim(dir, {
      listResponse: JSON.stringify([
        {
          id: 5,
          body: '<!-- conductor-report: pr-comment -->\nold report',
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
      ]),
    });
    const reportFile = path.join(dir, 'conductor.txt');
    writeFileSync(reportFile, 'conductor: 1 gate blocked.');

    const run = runCli(['--report', reportFile, '--pr', '42', '--repo', 'acme/widgets'], { bin });

    expect(run.status).toBe(0);
    const argv = readArgv(record);
    expect(argv[1]).toEqual([
      'api',
      'repos/acme/widgets/issues/comments/5',
      '-X',
      'PATCH',
      // -F/--field, never -f/--raw-field: see the create-comment case above.
      expect.stringMatching(/^-F$/),
      expect.stringMatching(/^body=@/),
    ]);
  });

  it('warns and exits 0 on a read-only token, the fork pull_request shape, without failing', () => {
    const dir = tempDir();
    // The list call is what a real fork run reaches first, and a read-only
    // GITHUB_TOKEN still permits reading comments; it is the write that is
    // refused. Failing on the create call reproduces that shape precisely.
    const { bin } = ghShim(dir, { failOn: 'issues/42/comments' });
    const reportFile = path.join(dir, 'conductor.txt');
    writeFileSync(reportFile, 'conductor: clean, nothing blocked.');

    const run = runCli(['--report', reportFile, '--pr', '42', '--repo', 'acme/widgets'], { bin });

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/::warning::/);
    expect(run.stdout.toLowerCase()).toMatch(/could not post/);
    expect(run.stdout.toLowerCase()).toMatch(/fork/);
  });

  it('warns and exits 0 rather than failing when required flags are missing', () => {
    const dir = tempDir();
    const { bin } = ghShim(dir);

    const run = runCli(['--report', path.join(dir, 'missing.txt')], { bin });

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/::warning::/);
  });

  it('warns and exits 0 rather than failing when the report file cannot be read', () => {
    const dir = tempDir();
    const { bin } = ghShim(dir);

    const run = runCli(
      ['--report', path.join(dir, 'does-not-exist.txt'), '--pr', '42', '--repo', 'acme/widgets'],
      { bin },
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/::warning::/);
  });
});
