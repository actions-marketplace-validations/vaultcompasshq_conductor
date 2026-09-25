#!/usr/bin/env node
// The CLI wrapper `action.yml`'s pull-request-comment step invokes:
//
//   node "$ACTION_PATH/scripts/pr-comment.mjs" \
//     --report <file> --pr <number> --repo <owner/repo>
//
// It reads conductor's own text report off disk and hands it to
// `postReport` (scripts/lib/pr-comment.mjs) to post or update as a sticky
// pull request comment.
//
// NOTHING HERE MAY EXIT NON-ZERO OR THROW UNCAUGHT. This step is opt-in and
// advisory: a comment that fails to post -- a fork pull_request's read-only
// GITHUB_TOKEN is the expected case, but a missing flag or an unreadable
// report file are treated the same way -- prints a `::warning::` line and
// exits 0. The gate's own pass/fail is decided entirely by the "Run the
// gates" step earlier in action.yml; this file cannot see that verdict and
// must not be able to affect it either.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { postReport } from './lib/pr-comment.mjs';

/** `--report <file> --pr <number> --repo <owner/repo> [--marker <text>]`. */
export function parseArgs(argv) {
  const opts = { report: null, pr: null, repo: null, marker: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report') {
      opts.report = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--pr') {
      opts.pr = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--repo') {
      opts.repo = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--marker') {
      opts.marker = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

/**
 * The one seam that reaches the network: a `gh` argument vector in,
 * `{ stdout }` out, or a throw carrying `gh`'s own stderr. `gh` reads its
 * token from the `GH_TOKEN` (or `GITHUB_TOKEN`) environment variable itself,
 * so nothing here has to pass it on the command line.
 *
 * Exported so scripts/tests/pr-comment-smoke.test.mjs can drive a real `gh`
 * binary through this exact seam. The unit test suite (pr-comment.test.mjs,
 * pr-comment-cli.test.mjs) replaces `gh` with a shim that cannot tell
 * `-f` from `-F`: both take a `key=value` string and neither shim reads the
 * `@file` form, so a regression from -F back to -f would pass every offline
 * test while breaking against a real `gh`. The smoke test is what actually
 * exercises the real binary's own file-read behavior.
 */
export function ghRun(argv) {
  const result = spawnSync('gh', argv, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `gh exited with status ${result.status}`;
    throw new Error(detail);
  }
  return { stdout: result.stdout ?? '' };
}

function warn(message) {
  // GitHub Actions reads `::warning::` annotations from stdout, the same
  // convention every other diagnostic in this action's steps follows.
  process.stdout.write(`::warning::${message}\n`);
}

function main() {
  const { report, pr, repo, marker } = parseArgs(process.argv.slice(2));

  if (!report || !pr || !repo) {
    warn(
      'conductor: the pr-comment step is missing --report, --pr or --repo; skipping the pull ' +
        'request comment. The gate\'s own verdict is unaffected.',
    );
    return;
  }

  let reportText;
  try {
    reportText = readFileSync(report, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(
      'conductor: could not read the report file to post as a pull request comment ' +
        `(${detail}). The gate's own verdict is unaffected.`,
    );
    return;
  }

  // An empty report is never posted as if it were a result. This is how the
  // 2026-09-22 incident reached the pull request: the step's render run had
  // failed, nothing was written, and an empty file was posted as though it
  // were a verdict.
  //
  // The action now branches before this point and writes a could-not-run note
  // itself, so this should be unreachable. Kept anyway, deliberately: that
  // incident was three individually correct mechanisms composing into
  // silence, and "unreachable by design" is exactly the kind of claim that
  // decays without anyone noticing.
  if (reportText.trim() === '') {
    reportText =
      'conductor: the gate could not produce a report for this pull request, so ' +
      'nothing here is a verdict. The reason is in the job log.';
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'conductor-pr-comment-'));
  const writeBodyFile = (body) => {
    const file = path.join(tmpDir, 'comment-body.md');
    writeFileSync(file, body, 'utf8');
    return file;
  };

  const result = postReport({ run: ghRun, repo, pr, reportText, marker, writeBodyFile });
  if (!result.posted) {
    warn(result.warning);
  }
}

// realpath both sides before comparing: on macOS the OS temp dir (and other
// mount points) resolve through a symlink, so a naive string comparison
// between import.meta.url and process.argv[1] can disagree and skip main()
// on a machine where nothing is actually wrong. The same device
// check-public-hygiene.mjs uses.
function isMainModule() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return pathToFileURL(process.argv[1]).href === new URL(import.meta.url).href
      || fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // The outermost safety net: whatever went wrong, this process exits 0.
  // A posting failure is handled inside main() itself and already prints its
  // own warning; this only catches something main() did not anticipate.
  try {
    main();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(
      `conductor: the pull request comment step failed unexpectedly (${detail}). The gate's ` +
        "own verdict is unaffected.",
    );
  }
}
