// The pull-request comment surface: conductor's existing TEXT REPORT, posted
// (and kept up to date) as a pull request comment when a consumer opts in.
//
// The one thing worth testing here is NOT the report's content -- that
// belongs to output-text.test.ts, which already covers it -- it is the
// posting logic: the marker that makes the comment STICKY across re-runs,
// the report going to `gh` BY FILE rather than interpolated into a command,
// and the FORK-SAFE degrade: a posting failure must warn and never throw, so
// the pull-request comment step can never fail the action or change the
// gate's verdict.
//
// `run` is the one seam that reaches the network (a `gh` invocation). Every
// case here hands `postReport` a recording stand-in for it, so nothing in
// this file makes a real network call.

import { describe, expect, it } from '@jest/globals';

import {
  MARKER,
  buildCommentBody,
  createCommentArgs,
  fenceReport,
  findMarkedCommentId,
  listCommentsArgs,
  postReport,
  updateCommentArgs,
} from '../lib/pr-comment.mjs';

describe('fenceReport', () => {
  it('wraps the report in a text code fence', () => {
    const fenced = fenceReport('conductor: clean, nothing blocked. 2 gate(s) ran.');
    expect(fenced).toMatch(/^```text\n/);
    expect(fenced).toMatch(/\n```$/);
    expect(fenced).toContain('conductor: clean, nothing blocked. 2 gate(s) ran.');
  });

  it('widens a literal triple backtick in the report so it cannot close the fence early', () => {
    // The report is conductor's own output, but it can carry a finding's own
    // text or a scanned path verbatim. Content is never trusted to be free of
    // the one sequence that would let it escape the fence it is inside.
    const fenced = fenceReport('a report line containing ``` right here');
    const lines = fenced.split('\n');
    // Exactly two fence delimiters: the opening and closing ones this
    // function itself wrote. Anything from the report that would have been a
    // third is neutralised.
    const fenceLines = lines.filter((line) => line.trim() === '```text' || line.trim() === '```');
    expect(fenceLines).toEqual(['```text', '```']);
  });
});

describe('buildCommentBody', () => {
  it('puts the hidden marker in the body, ahead of the fenced report', () => {
    const body = buildCommentBody('conductor: clean, nothing blocked. 2 gate(s) ran.', MARKER);
    expect(body.indexOf(MARKER)).toBe(0);
    expect(body).toContain('```text');
    expect(body).toContain('conductor: clean, nothing blocked. 2 gate(s) ran.');
  });

  it('renders the marker as an HTML comment, so it stays invisible on the pull request', () => {
    expect(MARKER.startsWith('<!--')).toBe(true);
    expect(MARKER.endsWith('-->')).toBe(true);
  });
});

const BOT_AUTHOR = { login: 'github-actions[bot]', type: 'Bot' };
const HUMAN_AUTHOR = { login: 'someone', type: 'User' };

describe('findMarkedCommentId', () => {
  it('finds the id of the bot-authored comment carrying the marker', () => {
    const comments = [
      { id: 1, body: 'an unrelated comment', user: HUMAN_AUTHOR },
      { id: 2, body: `${MARKER}\nprior conductor report`, user: BOT_AUTHOR },
      { id: 3, body: 'another unrelated comment', user: HUMAN_AUTHOR },
    ];
    expect(findMarkedCommentId(comments, MARKER)).toBe(2);
  });

  it('returns null when no comment carries the marker, so a fresh one is created', () => {
    const comments = [{ id: 1, body: 'an unrelated comment', user: HUMAN_AUTHOR }];
    expect(findMarkedCommentId(comments, MARKER)).toBeNull();
  });

  it('returns null on an empty comment list', () => {
    expect(findMarkedCommentId([], MARKER)).toBeNull();
  });

  it('does NOT match a marker planted in a comment authored by a human, so conductor never PATCHes it', () => {
    // On pull_request_target with a write token, anyone who can comment on
    // the pull request can plant the marker in a comment they author before
    // conductor's first run. Matching on the marker alone would then have
    // conductor repeatedly PATCH the attacker's own comment -- which they
    // can edit afterward to display a forged clean report. Requiring the
    // bot identity closes that: a human-authored comment carrying the
    // marker is never matched, so conductor creates its own instead.
    const comments = [
      { id: 1, body: `${MARKER}\nforged clean report`, user: HUMAN_AUTHOR },
    ];
    expect(findMarkedCommentId(comments, MARKER)).toBeNull();
  });

  it('matches a marker in a comment authored by the GitHub Actions bot', () => {
    const comments = [
      { id: 4, body: `${MARKER}\nprior conductor report`, user: BOT_AUTHOR },
    ];
    expect(findMarkedCommentId(comments, MARKER)).toBe(4);
  });

  it('does not match a marked comment with no user field at all', () => {
    const comments = [{ id: 5, body: `${MARKER}\nprior conductor report` }];
    expect(findMarkedCommentId(comments, MARKER)).toBeNull();
  });
});

describe('the gh argument vectors', () => {
  it('lists comments by owner/repo and pull request number', () => {
    expect(listCommentsArgs('acme/widgets', 42)).toEqual([
      'api',
      'repos/acme/widgets/issues/42/comments',
      '--paginate',
    ]);
  });

  it('creates a comment with the body read from a file via -F, never -f', () => {
    // gh's `@<path>` file-read form only works with -F/--field. -f/--raw-field
    // sends the literal string, so `-f body=@/tmp/body.md` would post the
    // literal text "@/tmp/body.md" as the comment body instead of the file's
    // contents.
    const args = createCommentArgs('acme/widgets', 42, '/tmp/body.md');
    expect(args).toEqual(['api', 'repos/acme/widgets/issues/42/comments', '-F', 'body=@/tmp/body.md']);
    expect(args).not.toContain('-f');
    // No element of the argument vector carries report-shaped prose: the only
    // way the body reaches gh is the @-file reference.
    for (const arg of args) {
      expect(arg).not.toContain('conductor:');
    }
  });

  it('updates the existing comment by id, also by file via -F, with PATCH', () => {
    const args = updateCommentArgs('acme/widgets', 2, '/tmp/body.md');
    expect(args).toEqual([
      'api',
      'repos/acme/widgets/issues/comments/2',
      '-X',
      'PATCH',
      '-F',
      'body=@/tmp/body.md',
    ]);
    expect(args).not.toContain('-f');
  });
});

/** A recording stand-in for the one seam that reaches the network. */
function recordingRunner(responses) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    const next = responses.shift();
    if (next === undefined) {
      return { stdout: '{}' };
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { run, calls };
}

function recordingBodyWriter() {
  const writes = [];
  const writeBodyFile = (body) => {
    const file = `/tmp/conductor-pr-comment-${writes.length}.md`;
    writes.push({ file, body });
    return file;
  };
  return { writeBodyFile, writes };
}

describe('postReport', () => {
  it('creates a new comment when no prior marked comment exists', () => {
    const { run, calls } = recordingRunner([
      { stdout: JSON.stringify([{ id: 1, body: 'unrelated' }]) },
      { stdout: JSON.stringify({ id: 99 }) },
    ]);
    const { writeBodyFile, writes } = recordingBodyWriter();

    const result = postReport({
      run,
      repo: 'acme/widgets',
      pr: 42,
      reportText: 'conductor: clean, nothing blocked. 2 gate(s) ran.',
      writeBodyFile,
    });

    expect(result).toEqual({ posted: true, updated: false, commentId: 99 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(listCommentsArgs('acme/widgets', 42));
    expect(calls[1]).toEqual(createCommentArgs('acme/widgets', 42, writes[0].file));
    // The report reached gh only through the file the body writer produced.
    expect(writes[0].body).toContain('conductor: clean, nothing blocked. 2 gate(s) ran.');
    expect(writes[0].body.indexOf(MARKER)).toBe(0);
  });

  it('updates the existing marked comment in place instead of creating a second one', () => {
    const { run, calls } = recordingRunner([
      { stdout: JSON.stringify([{ id: 7, body: `${MARKER}\nold report`, user: BOT_AUTHOR }]) },
      { stdout: '{}' },
    ]);
    const { writeBodyFile, writes } = recordingBodyWriter();

    const result = postReport({
      run,
      repo: 'acme/widgets',
      pr: 42,
      reportText: 'conductor: 1 gate blocked.',
      writeBodyFile,
    });

    expect(result).toEqual({ posted: true, updated: true, commentId: 7 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(updateCommentArgs('acme/widgets', 7, writes[0].file));
  });

  it('degrades gracefully on a posting failure: warns, never throws, reports posted: false', () => {
    // The shape of a fork pull_request: the default GITHUB_TOKEN is
    // read-only, so `gh api` exits non-zero and this is the one seam that
    // sees it.
    const { run } = recordingRunner([
      new Error('HTTP 403: Resource not accessible by integration'),
    ]);
    const { writeBodyFile } = recordingBodyWriter();

    let thrown = null;
    let result;
    try {
      result = postReport({
        run,
        repo: 'acme/widgets',
        pr: 42,
        reportText: 'conductor: clean, nothing blocked.',
        writeBodyFile,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeNull();
    expect(result.posted).toBe(false);
    expect(result.warning).toMatch(/could not post/i);
    expect(result.warning).toMatch(/fork/i);
    // The underlying cause is folded in, so a reader is not left guessing.
    expect(result.warning).toContain('403');
  });

  it('also degrades gracefully when the failure happens on the update path', () => {
    const { run } = recordingRunner([
      { stdout: JSON.stringify([{ id: 7, body: `${MARKER}\nold report`, user: BOT_AUTHOR }]) },
      new Error('HTTP 403: Resource not accessible by integration'),
    ]);
    const { writeBodyFile } = recordingBodyWriter();

    const result = postReport({
      run,
      repo: 'acme/widgets',
      pr: 42,
      reportText: 'conductor: clean, nothing blocked.',
      writeBodyFile,
    });

    expect(result.posted).toBe(false);
    expect(result.warning).toMatch(/could not post/i);
  });

  it('creates its own comment rather than adopting a marker an attacker planted in a human comment', () => {
    // pull_request_target hands conductor's step a write token; anyone who
    // can comment on the pull request can author a comment carrying the
    // marker before conductor's own first run. If postReport matched on the
    // marker alone it would PATCH that attacker-authored comment forever
    // after, which the attacker can then edit to show a forged clean
    // report. It must create its own comment instead.
    const { run, calls } = recordingRunner([
      {
        stdout: JSON.stringify([
          { id: 1, body: `${MARKER}\nforged clean report`, user: HUMAN_AUTHOR },
        ]),
      },
      { stdout: JSON.stringify({ id: 99 }) },
    ]);
    const { writeBodyFile } = recordingBodyWriter();

    const result = postReport({
      run,
      repo: 'acme/widgets',
      pr: 42,
      reportText: 'conductor: 1 gate blocked.',
      writeBodyFile,
    });

    expect(result).toEqual({ posted: true, updated: false, commentId: 99 });
    expect(calls[1]).toEqual([
      'api',
      'repos/acme/widgets/issues/42/comments',
      '-F',
      expect.stringMatching(/^body=@/),
    ]);
  });
});
