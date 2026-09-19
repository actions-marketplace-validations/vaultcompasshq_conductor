// A REAL-`gh` smoke test for the pull-request comment surface.
//
// Every other test touching this feature (pr-comment.test.mjs,
// pr-comment-cli.test.mjs) replaces `gh` with a recorder or a shim that only
// checks its own argv shape. That is deliberate -- it keeps `pnpm test`
// offline and fast -- but it also means those tests CANNOT catch a
// `-f`/`-F` regression: both flags accept a `key=value` string, so a shim
// that never actually reads the `@file` form cannot tell them apart. Only a
// real `gh` binary knows that `-f body=@/tmp/x` posts the literal text
// "@/tmp/x" while `-F body=@/tmp/x` reads the file. This suite is what
// actually proves that distinction, against the real network.
//
// SKIPPED, not failed, whenever the prerequisites are not present: a real
// `gh` on PATH, a token it can use, and a scratch pull request or issue this
// suite is allowed to comment on and clean up after itself. None of those
// belong to a laptop or CI runner by default, so a normal offline `pnpm
// test` run skips this file entirely and stays green. Run it for real
// before a release that ships a change to this surface (see the README's
// "The report as a pull request comment" section) with:
//
//   GH_TOKEN=<a token with pull-requests: write on the target>
//   CONDUCTOR_PR_COMMENT_SMOKE_REPO=owner/repo
//   CONDUCTOR_PR_COMMENT_SMOKE_ISSUE=<issue or pull request number>
//   pnpm test -- scripts/tests/pr-comment-smoke.test.mjs
//
// The target only needs to be commentable; an ordinary issue works as well
// as a pull request, since the comments API is the same endpoint for both.

import { afterAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MARKER, buildCommentBody, postReport, updateCommentArgs } from '../lib/pr-comment.mjs';
import { ghRun } from '../pr-comment.mjs';

function ghOnPath() {
  const found = spawnSync('sh', ['-c', 'command -v gh'], { encoding: 'utf8' });
  const value = (found.stdout ?? '').trim();
  return found.status === 0 && value.length > 0;
}

const REPO = process.env.CONDUCTOR_PR_COMMENT_SMOKE_REPO ?? '';
const ISSUE = process.env.CONDUCTOR_PR_COMMENT_SMOKE_ISSUE ?? '';
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

const missing = [
  ghOnPath() ? null : 'no gh binary on PATH',
  TOKEN.length > 0 ? null : 'no GH_TOKEN or GITHUB_TOKEN in the environment',
  REPO.length > 0 ? null : 'CONDUCTOR_PR_COMMENT_SMOKE_REPO is not set',
  ISSUE.length > 0 ? null : 'CONDUCTOR_PR_COMMENT_SMOKE_ISSUE is not set',
].filter((entry) => entry !== null);

const describeSmoke = missing.length === 0 ? describe : describe.skip;

if (missing.length > 0) {
  // Not a failure: this is exactly the "skipped offline" case the header
  // comment above documents. Printed once, at collection time, so a run
  // that skips this file still says why in the test output.
  console.log(
    `pr-comment-smoke: skipped (${missing.join('; ')}). See scripts/tests/pr-comment-smoke.test.mjs ` +
      'for how to run this against a real gh.',
  );
}

describeSmoke('postReport against a real gh binary', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'conductor-pr-comment-smoke-'));
  const marker = `${MARKER.slice(0, -3)} smoke:${Date.now()} -->`;
  let createdCommentId = null;

  function writeBodyFile(body) {
    const file = path.join(tmpDir, 'comment-body.md');
    writeFileSync(file, body, 'utf8');
    return file;
  }

  function fetchCommentBody(commentId) {
    const result = ghRun(['api', `repos/${REPO}/issues/comments/${commentId}`]);
    return JSON.parse(result.stdout).body;
  }

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (createdCommentId !== null) {
      try {
        ghRun(['api', `repos/${REPO}/issues/comments/${createdCommentId}`, '-X', 'DELETE']);
      } catch {
        // Best-effort cleanup; a leaked scratch comment on the smoke target
        // is not this test's verdict.
      }
    }
  });

  it('creates a comment whose body is the report text, not the literal @file path', () => {
    const firstReportText = `conductor smoke test: first post ${Date.now()}`;

    const result = postReport({
      run: ghRun,
      repo: REPO,
      pr: ISSUE,
      reportText: firstReportText,
      marker,
      writeBodyFile,
    });

    expect(result.posted).toBe(true);
    expect(result.updated).toBe(false);
    expect(typeof result.commentId).toBe('number');
    createdCommentId = result.commentId;

    const body = fetchCommentBody(result.commentId);
    // The bug this suite exists to catch: `-f body=@<path>` posts the
    // literal string "@<path>" instead of the file's contents. Asserting
    // both directions is what actually proves the file was read rather than
    // quoted.
    expect(body).not.toContain('@' + tmpDir);
    expect(body).toContain(firstReportText);
  }, 30000);

  // This drives updateCommentArgs directly by the id the create step above
  // returned, rather than going back through postReport's own list-and-match
  // (findMarkedCommentId). That match now also requires the comment to be
  // authored by the GitHub Actions bot (the fix for the second review
  // finding on this surface); a personal access token run from a laptop or
  // this test's own CI job authenticates as a human or a different app, not
  // as `github-actions[bot]`, so it could never satisfy that check and the
  // "updates in place" case would falsely appear broken here. The
  // bot-authorship match itself is proven with a fake user object in
  // pr-comment.test.mjs, where the authorship is a value under this suite's
  // control; a real gh binary is not required to prove that half. What a
  // real gh binary IS required to prove is that the PATCH request-f/-F
  // distinction: this is that proof.
  it('updates that same comment in place via -F, still reading the body from file', () => {
    const secondReportText = `conductor smoke test: second post ${Date.now()}`;
    const bodyFile = writeBodyFile(buildCommentBody(secondReportText, marker));

    ghRun(updateCommentArgs(REPO, createdCommentId, bodyFile));

    const body = fetchCommentBody(createdCommentId);
    expect(body).not.toContain('@' + tmpDir);
    expect(body).toContain(secondReportText);
    expect(body).not.toContain('first post');
  }, 30000);
});
