// The pull-request comment surface: conductor's own TEXT REPORT, posted as a
// pull request comment for an advisory (non-required) run whose findings
// would otherwise live only in a job's exit code and log.
//
// STICKY, not "one comment per run". A hidden HTML-comment marker at the top
// of the body identifies conductor's own comment; a re-run searches for it
// and PATCHes that comment in place rather than adding a new one each push.
//
// FORK-SAFE, not "best effort with a stack trace in the log". On a fork
// pull_request the default GITHUB_TOKEN is read-only, so posting fails.
// postReport() below never throws: a posting failure comes back as
// `{ posted: false, warning }`, so the caller can print the warning and
// continue. The gate's own pass/fail is decided elsewhere (the gates step in
// action.yml) and nothing here can change it.
//
// The report reaches `gh` BY FILE, never interpolated into a command line.
// The report is conductor's own output, but it can carry a finding's text or
// a path out of the scanned repository, and a command line is not a safe
// place for either.

/**
 * The hidden marker that makes the comment findable and sticky. An HTML
 * comment, so it renders as nothing on the pull request itself.
 */
export const MARKER = '<!-- conductor-report: pr-comment -->';

/**
 * Wraps the report in a `text` code fence, so nothing in it renders as
 * active markdown or breaks out of the block conductor's own comment lives
 * in.
 *
 * The report is conductor's own output, not arbitrary input, but it can
 * carry a finding's own text or a path taken from the scanned repository
 * verbatim, and neither is a place this trusts to be free of a literal
 * triple backtick. One is widened with a zero-width space so it cannot close
 * the fence early; nothing about the report's own content is otherwise
 * changed.
 */
export function fenceReport(reportText) {
  const safe = String(reportText).replace(/```/g, '``​`');
  return ['```text', safe, '```'].join('\n');
}

/**
 * The full comment body: the marker first, so `findMarkedCommentId` can
 * find it in the body GitHub hands back, then the fenced report.
 */
export function buildCommentBody(reportText, marker = MARKER) {
  return [marker, '### Conductor report', '', fenceReport(reportText), ''].join('\n');
}

/**
 * The GitHub Actions bot's own identity on a comment the default
 * `GITHUB_TOKEN` posts: `user.login` is `github-actions[bot]` and
 * `user.type` is `Bot`. Both are checked, not just one, so a comment is
 * only ever treated as conductor's own when it carries the exact identity
 * conductor's own posts under.
 *
 * LATENT COUPLING: this literal is correct only because action.yml pins the
 * comment step's `GH_TOKEN` to `${{ github.token }}`, so the step always
 * posts as github-actions[bot] and always matches its own comments. If the
 * step's token is ever made configurable (an App token or a PAT authors
 * comments under a different login), this gate must change in lockstep, or
 * conductor stops recognizing its own comment and creates a new one every
 * run. Keep the two in step.
 */
const BOT_LOGIN = 'github-actions[bot]';

function isPostedByTheActionsBot(comment) {
  const user = comment?.user;
  return user?.type === 'Bot' && user?.login === BOT_LOGIN;
}

/**
 * The id of the comment carrying the marker AND authored by the GitHub
 * Actions bot, or null when no such comment exists.
 *
 * `comments` is the parsed JSON array `gh api .../issues/:pr/comments`
 * returns: each entry at minimum `{ id, body, user: { login, type } }`.
 * Null means "no prior conductor comment on this pull request", which is
 * exactly the signal to create one rather than update one.
 *
 * The bot-identity check matters most on `pull_request_target`, which hands
 * this step a write token even though the pull request itself is
 * untrusted: anyone who can comment on the pull request can plant the
 * marker in a comment THEY author before conductor's first run. Matching on
 * the marker alone would then have conductor repeatedly PATCH the
 * attacker's own comment, which they can edit afterward to display a
 * forged clean report. Requiring the marker AND the bot identity closes
 * that: a marker in a human-authored comment is never matched, so
 * conductor creates its own comment instead, exactly as if no marked
 * comment existed at all.
 */
export function findMarkedCommentId(comments, marker = MARKER) {
  for (const comment of comments ?? []) {
    if (
      typeof comment?.body === 'string' &&
      comment.body.includes(marker) &&
      isPostedByTheActionsBot(comment)
    ) {
      return comment.id;
    }
  }
  return null;
}

/** Every existing comment on the pull request, oldest marked one wins. */
export function listCommentsArgs(repo, pr) {
  return ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate'];
}

/**
 * Creates a new comment. `bodyFile` is a path; `gh api`'s `@file` value form
 * reads the body from it, which is what keeps the report out of the
 * argument vector.
 *
 * -F/--field, deliberately, never -f/--raw-field: gh's `@<path>` file-read
 * form is only recognized by -F. -f sends the value as a literal string, so
 * `-f body=@/tmp/x` would post the literal text "@/tmp/x" as the comment
 * body instead of the file's contents, silently defeating both the report
 * and the marker-based stickiness (the literal path carries no marker, so
 * every run would create a new comment rather than updating one).
 */
export function createCommentArgs(repo, pr, bodyFile) {
  return ['api', `repos/${repo}/issues/${pr}/comments`, '-F', `body=@${bodyFile}`];
}

/** Updates an existing comment in place, also by file, also via -F. */
export function updateCommentArgs(repo, commentId, bodyFile) {
  return ['api', `repos/${repo}/issues/comments/${commentId}`, '-X', 'PATCH', '-F', `body=@${bodyFile}`];
}

/**
 * Posts, or updates, conductor's text report as a pull request comment.
 *
 * `run(argv)` is the one seam that reaches the network: a `gh` argument
 * vector in, `{ stdout }` out, or a throw on failure. The default CLI
 * wrapper (`scripts/pr-comment.mjs`) passes a real `gh` invocation; the test
 * suite passes a recorder, so every case is provable without a network call.
 *
 * `writeBodyFile(body)` writes the comment body somewhere on disk and
 * returns the path, so the report reaches `gh` by file rather than by
 * argument. Injected rather than hardcoded to `node:fs` so a test can assert
 * on exactly what was written without touching a real filesystem.
 *
 * NEVER THROWS. A posting failure -- most commonly the read-only
 * `GITHUB_TOKEN` Actions hands a fork `pull_request`, but also a rate limit
 * or a transient API error -- is exactly the case this exists to degrade
 * gracefully from. The caller gets `{ posted: false, warning }` rather than
 * an exception, and nothing here can fail the action or change the gate's
 * own verdict.
 */
export function postReport({ run, repo, pr, reportText, marker = MARKER, writeBodyFile }) {
  try {
    const bodyFile = writeBodyFile(buildCommentBody(reportText, marker));

    const listed = run(listCommentsArgs(repo, pr));
    const comments = JSON.parse(listed.stdout || '[]');
    const existingId = findMarkedCommentId(comments, marker);

    if (existingId !== null && existingId !== undefined) {
      run(updateCommentArgs(repo, existingId, bodyFile));
      return { posted: true, updated: true, commentId: existingId };
    }

    const created = run(createCommentArgs(repo, pr, bodyFile));
    let commentId = null;
    try {
      const parsed = JSON.parse(created.stdout || '{}');
      commentId = typeof parsed?.id === 'number' ? parsed.id : null;
    } catch {
      // gh's own stdout on a successful create is JSON; if it were not, the
      // comment still posted and the id is just not worth failing over.
      commentId = null;
    }
    return { posted: true, updated: false, commentId };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      posted: false,
      warning:
        'conductor: could not post the report as a pull request comment (no write token, ' +
        'likely a fork pull request, or the GitHub API was unreachable). The gate\'s own ' +
        `verdict is unaffected. (${detail})`,
    };
  }
}
