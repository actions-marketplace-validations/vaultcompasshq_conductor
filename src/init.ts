// `conductor init`: one policy file, one pre-commit hook, one manifest.
//
// The manifest is what makes --revert honest. Without one, "undo the init"
// means guessing which files were the tool's, and a tool that guesses about
// deletion in somebody's repository has to be wrong only once.
//
// Four properties are the whole point, and three of them are bugs some tool
// in this family has actually shipped:
//
//  1. FAIL CLOSED. A missing umbrella binary blocks the commit. The
//     tempting alternative, warning and letting the commit through so a
//     teammate without the tool is not stuck, means the gate is silently
//     absent exactly where it is most likely to be absent, and a guardrail
//     that is off when the tool is missing is a guardrail an attacker turns
//     off by making the tool missing.
//
//  2. PRESERVE THE EXIT CODE. 2 means a gate could not run; 1 means a gate
//     blocked. A hook written the natural way, `if conductor run; then exit
//     0; fi; exit 1`, collapses 2 into 1 and reports findings that were
//     never looked for.
//
//  3. A RELATIVE core.hooksPath RESOLVES AGAINST THE WORKTREE ROOT, not
//     against the .git directory. A sibling tool resolved it against the
//     .git directory and the test that covered the case asserted the same
//     wrong location, so the two agreed with each other and neither was
//     checked against git. The test here drives a real commit instead.
//
//  4. NEVER STACK A SECOND HOOK. If a gate already installed its own
//     pre-commit hook, adding the umbrella's alongside it means that gate
//     runs twice and its findings appear twice. Init reports the collision
//     and stops, or replaces the gate's hook when told to adopt it.
//
//  5. NEVER WRITE INTO A HOOK MANAGER'S GENERATED DIRECTORY. Where git
//     looks and where the hook a human maintains lives are not always the
//     same file. husky 9 sets core.hooksPath to .husky/_, a generated and
//     gitignored directory it rewrites on every install; the file git
//     executes there is a dispatcher that execs the TRACKED hook one
//     directory up. Reading the dispatcher reports the repository's real
//     gate hook as foreign, so --adopt cannot adopt it, and writing the
//     dispatcher puts the umbrella hook somewhere the next install deletes
//     without a word. Found by running this tool against a real husky 9
//     repository, which is the only way it could have been found: every
//     fixture in the suite agreed with the code.
//
//     The recognition rule is structural and nothing else: the hooks
//     directory is named `_` and its parent is named `.husky`. Only husky
//     creates that path. See huskyDirectoryFor for why neither the content
//     of the executed file nor the presence of husky's shim is allowed to
//     join the rule: the first fires against husky 8's tracked hook and
//     points init at the repository root, and the second fails exactly
//     after a `git clean -xdf` has removed the gitignored generated
//     directory, which is the state this whole property exists to survive.
//
//  6. A MANAGER WHOSE HOOK TEXT LIVES IN package.json IS REFUSED, AND THE
//     DECLARATION IS THE SIGNAL. simple-git-hooks and yorkie generate
//     .git/hooks/pre-commit from a key in package.json and rewrite it on
//     every install, and neither has a tracked file to write instead. What
//     makes them different from lefthook is that the declaration is there
//     BEFORE the manager has ever run: a fresh clone has no generated hook
//     to read, and that is exactly the state somebody runs init in. So the
//     package.json key is checked as well as the file, and either one alone
//     is enough. Found by running this tool against two of the eight public
//     repositories in a dogfood run: both would have taken the umbrella hook
//     and lost it at the next install, with the manifest still recording it
//     as installed. See detectManagedHook and declaredManagedHooks.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { Product } from './policy.js';

import {
  DEP_GUARD_HOOK_MARKER,
  INTENT_GUARD_HOOK_MARKER,
  MANAGED_HOOK_MARKER,
  declaredManagedHooks,
  detectGateHook,
  detectGeneratedHook,
  detectManagedHook,
  editedManagedGuidance,
  foreignGuidance,
  gateHookGuidance,
  generatedHookGuidance,
  huskyDirectoryFor,
  huskyShimPresent,
  managedHooksGuidance,
} from './init-hook-detect.js';
import type { HookManager, ManagedDeclaration, ManagedHookManager } from './init-hook-detect.js';

import {
  MANIFEST_RELATIVE_PATH,
  manifestPathInsideRepo,
  readIfExists,
  readManifest,
  recordedHookSha,
  sha256,
} from './init-manifest.js';
import type { Manifest, ManifestFile } from './init-manifest.js';

import { POLICY_FILE_NAME, detectGates, renderPolicy } from './init-policy.js';

export {
  MANAGED_HOOK_MARKER,
  MANIFEST_RELATIVE_PATH,
  DEP_GUARD_HOOK_MARKER,
  INTENT_GUARD_HOOK_MARKER,
  POLICY_FILE_NAME,
  renderPolicy,
};
export type { HookManager, ManagedHookManager };

const HOOK = `#!/bin/sh
# Guardrail pre-commit hook. ${MANAGED_HOOK_MARKER}
# Installed by "conductor init". Remove it with "conductor init --revert".
#
# No "set -e" of its own, and written to survive somebody else's. Under
# "set -e" a shell exits at the failing command before its status can be
# captured, which keeps the exit code but loses the explanatory line, so a
# blocked commit prints nothing about why. husky's dispatcher runs this
# file as "sh -e", so every command allowed to fail is in a condition
# context rather than standing alone.
#
# "command -v" rather than "which": "which" is not in POSIX, is absent from
# some minimal images, and reports success in some shells for a builtin
# that is not an executable.

# A conductor installed only as a devDependency of this repository is not
# on PATH, and was invisible to its own hook until this line existed: every
# commit reported the umbrella missing and blocked, which is the right
# answer to the wrong question. The root comes from git rather than from
# the working directory: git runs a pre-commit hook from the top level
# today, but a hook invoked by hand or by another manager can start in a
# subdirectory, where a relative "node_modules/.bin" points at nothing.
conductor_no_git=0
if command -v git >/dev/null 2>&1; then
  conductor_root=$(git rev-parse --show-toplevel 2>/dev/null) || conductor_root=""
  if [ -n "$conductor_root" ] && [ -d "$conductor_root/node_modules/.bin" ]; then
    PATH="$conductor_root/node_modules/.bin:$PATH"
    export PATH
  fi
else
  # Without git the root cannot be found, so node_modules/.bin cannot be
  # looked in, so a conductor installed only there is invisible. That is a
  # different fact from "conductor is not installed", and saying the second
  # one sends the reader off to reinstall a tool that may already be sitting
  # in the repository.
  conductor_no_git=1
fi

if ! command -v conductor >/dev/null 2>&1; then
  if [ "$conductor_no_git" -eq 1 ]; then
    echo "conductor: git is not on this hook's PATH, so the repository's node_modules/.bin could not be located and no conductor was found there or on PATH. This commit was NOT checked by any guardrail gate." >&2
  else
    echo "conductor: command not found, so this commit was NOT checked by any guardrail gate. Install the umbrella, or run 'conductor init --revert' to remove this hook." >&2
  fi
  exit 1
fi

# --stage commit, not every stage. A pre-commit hook IS the commit stopping
# point, and the gates are split across stopping points on ceremony rather
# than on runtime: the dependency and secret gates are silent until they
# find something, while the intent gate wants a contract approved before the
# work starts, which is a per-task human step and belongs at a pull request.
# Running everything here is what makes a team disable the hook.
conductor_status=0
conductor run --staged --stage commit || conductor_status=$?

# One message per exit code, not one message for both. The comment below
# says collapsing 2 into 1 would report findings never looked for, and a
# single human-readable line saying "commit blocked" for both did exactly
# that: exit 2 means a gate could not run, so nothing was checked, and
# calling that a blocked commit describes a decision nobody made.
#
# Neither line mentions a bypass flag. Every gate already has a recorded,
# reviewable, scoped escape: an allow entry, an ignore path, a baseline, or
# enforce: false in .guardrails.yaml. A bypass skips every gate invisibly,
# including the ones that would have caught something unrelated to the
# finding somebody disagreed with, and leaves no trace of the decision.
if [ "$conductor_status" -eq 1 ]; then
  echo "conductor: a gate blocked this commit. Review the report above. If you disagree with a finding, record the decision where the next reader can see it: an allow entry, an ignore path, or a baseline in that gate's own configuration, or enforce: false for the gate in .guardrails.yaml." >&2
elif [ "$conductor_status" -ne 0 ]; then
  # "If there is a report above" rather than "the report above". This branch
  # also catches an umbrella that crashed or was not executable, and exit 127
  # with no output at all is one of the shapes that reaches here. Sending
  # somebody to read a report that was never printed makes them hunt for
  # output rather than for the gate.
  echo "conductor: a gate could not run, so NOTHING was checked and this commit was not verified by any gate. If there is a report above, it names the gate and says why. Fix that before committing." >&2
fi

# Passed straight through. 1 means a gate blocked; 2 means a gate could not
# run at all. Collapsing 2 into 1 would report findings never looked for.
exit "$conductor_status"
`;

export type ConflictReason =
  | 'not-a-git-repository'
  | 'foreign-hook'
  | 'gate-hook'
  | 'generated-hook'
  /**
   * A manager whose hook text lives in package.json owns this file:
   * simple-git-hooks or yorkie. Distinct from generated-hook because the
   * remedy is different -- there is no config file of the manager's own to
   * point at, only a key in package.json that conductor will not write.
   */
  | 'managed-hooks'
  | 'hooks-path-outside-repository'
  /**
   * A path recorded in the manifest resolves outside the repository. The
   * manifest is a committed, untrusted file, so revert and apply refuse any
   * path in it that is not contained rather than writing or deleting where it
   * points.
   */
  | 'manifest-path-outside-repository'
  | 'no-manifest'
  | 'manifest-unreadable'
  | 'changed-since-init'
  | 'write-failed';

export interface InitConflict {
  path: string;
  reason: ConflictReason;
  guidance: string;
}

export interface InitAction {
  kind: 'write' | 'skip' | 'remove' | 'restore';
  path: string;
  detail: string;
}

export interface AdoptedHook {
  product: Product;
  content: string;
}

export interface InitResult {
  ok: boolean;
  dryRun: boolean;
  alreadyInstalled: boolean;
  actions: InitAction[];
  conflicts: InitConflict[];
  /** Absolute path of the hook file, empty when there is nothing to write. */
  hookPath: string;
  /**
   * Which hook manager owns this repository's pre-commit hook, as detected.
   * `husky` means hookPath is the TRACKED file rather than the generated
   * one git executes.
   */
  hookManager: HookManager;
  repoRoot: string;
  adoptedFrom: AdoptedHook | null;
  /** Contents to write, keyed by absolute path. Empty on a dry run's apply. */
  writes: Array<{
    path: string;
    content: string;
    executable: boolean;
    kind: 'hook' | 'policy';
  }>;
  /**
   * Files already on disk in exactly the right state, which the manifest is
   * nevertheless missing.
   *
   * Nothing is written for these: the bytes are correct already. They exist
   * because the manifest is what makes --revert honest, and a file init put
   * there but cannot prove it put there is one revert walks past. Recording
   * the content that is already on disk is what turns "I found this" into
   * "this is mine to remove".
   */
  records: Array<{ path: string; content: string; kind: 'hook' | 'policy' }>;
}

export interface InitOptions {
  cwd: string;
  /** PATH used for gate detection. Injected so tests never depend on the machine. */
  pathValue: string;
  dryRun?: boolean;
  /** Replace a per-gate hook with the umbrella's. Never replaces a foreign one. */
  adopt?: boolean;
  /**
   * Act on a file that has changed since init wrote it: on init, replace a
   * managed hook somebody has edited; on revert, remove one. Never touches a
   * foreign or gate-owned hook, which have their own routes.
   */
  force?: boolean;
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The working-tree root, or null when cwd is not inside a repository.
 *
 * Asked of git rather than probed for a `.git` entry, so init works from a
 * subdirectory and gets a worktree or a submodule right, where `.git` is a
 * file rather than a directory.
 */
function repoRootOf(cwd: string): string | null {
  return gitOutput(cwd, ['rev-parse', '--show-toplevel']);
}

interface HooksDir {
  dir: string;
  /** True when a configured hooksPath points outside the repository. */
  outside: boolean;
  /**
   * True when git executes hooks out of the git directory's own `hooks/`,
   * which is where a repository with no `core.hooksPath` looks.
   *
   * Derived by COMPARING THE RESOLVED PATHS rather than by testing whether
   * `core.hooksPath` is set, because a repository may set it to exactly the
   * place git already looks. That is a no-op for every purpose here, and a
   * rule phrased as "nothing is configured" would answer differently for two
   * repositories git treats identically.
   */
  isDefault: boolean;
}

function effectiveHooksDir(cwd: string, root: string): HooksDir {
  const gitDir = gitOutput(cwd, ['rev-parse', '--git-dir']);
  const hooksPath = gitOutput(cwd, ['config', '--get', 'core.hooksPath']) ?? '';

  // With no core.hooksPath, hooks live in the git DIRECTORY, which is not
  // the working-tree root: for a linked worktree or a submodule it is
  // somewhere else entirely, so this one resolves against gitDir.
  const defaultDir = path.join(path.resolve(cwd, gitDir ?? '.git'), 'hooks');

  if (hooksPath.length === 0) {
    return { dir: defaultDir, outside: false, isDefault: true };
  }

  // A RELATIVE core.hooksPath resolves against the WORKING-TREE ROOT.
  // Verified by experiment rather than by reading the documentation that
  // was misread the first time this was written in a sibling tool.
  const dir = path.isAbsolute(hooksPath) ? hooksPath : path.join(root, hooksPath);
  const relative = path.relative(root, dir);
  const outside = relative.startsWith('..') || path.isAbsolute(relative);
  return { dir, outside, isDefault: samePath(dir, defaultDir) };
}

/**
 * Whether two paths name the same directory.
 *
 * Through `realpath`, not string comparison, because the two sides arrive by
 * different routes: the default is built from the working directory the
 * caller passed in, and a configured `core.hooksPath` resolves against the
 * root git reported, which git has already resolved. On macOS the system
 * temporary directory is a symlink, so those two spell the same directory
 * two ways and a string compare answers "different" for a repository git
 * treats as one place. Falls back to the resolved strings when a path does
 * not exist yet, which is the ordinary case for a hooks directory init is
 * about to create.
 */
function samePath(left: string, right: string): boolean {
  const real = (candidate: string): string => {
    try {
      return realpathSync(candidate);
    } catch {
      return path.resolve(candidate);
    }
  };
  return real(left) === real(right);
}

export function planInit(options: InitOptions): InitResult {
  const dryRun = Boolean(options.dryRun);
  const actions: InitAction[] = [];
  const conflicts: InitConflict[] = [];
  const writes: InitResult['writes'] = [];
  const records: InitResult['records'] = [];

  const base: InitResult = {
    ok: false,
    dryRun,
    alreadyInstalled: false,
    actions,
    conflicts,
    hookPath: '',
    hookManager: 'native',
    repoRoot: '',
    adoptedFrom: null,
    writes,
    records,
  };

  const root = repoRootOf(options.cwd);
  if (root === null) {
    conflicts.push({
      path: '.git',
      reason: 'not-a-git-repository',
      guidance: 'Run "git init" first: a pre-commit hook has nothing to attach to otherwise.',
    });
    return base;
  }

  const hooks = effectiveHooksDir(options.cwd, root);
  if (hooks.outside) {
    conflicts.push({
      path: hooks.dir,
      reason: 'hooks-path-outside-repository',
      guidance:
        `core.hooksPath points at ${hooks.dir}, outside this repository. Writing there would ` +
        'install this repository hook on every repository on the machine. Set a repository-local ' +
        'core.hooksPath (git config core.hooksPath .git/hooks) and re-run init.',
    });
    return { ...base, repoRoot: root };
  }

  // What git executes. Under husky this is a generated dispatcher rather
  // than the hook anybody maintains, so it decides the manager and then
  // stops being the file this function is about.
  const executedHookPath = path.join(hooks.dir, 'pre-commit');
  const executedHook = readIfExists(executedHookPath);

  // The redirect fires on husky's OWN generated directory, recognised by
  // its shape alone. The tracked hook is then that .husky directory's own
  // pre-commit, which is what husky's shim runs:
  // `s=$(dirname "$(dirname "$0")")/$n`. Never a computed parent of an
  // arbitrary hooks directory, never decided by the content of the file git
  // executes (on husky 8 that file IS the tracked hook), and never
  // conditional on husky's shim being present (a clean deletes it, and the
  // repository is still husky's).
  const huskyDir = huskyDirectoryFor(hooks.dir);
  const husky = huskyDir !== null;

  if (!husky) {
    const rel = path.relative(root, executedHookPath).split(path.sep).join('/');

    if (executedHook !== undefined) {
      const generatedBy = detectGeneratedHook(executedHook);
      if (generatedBy !== null) {
        conflicts.push({
          path: rel,
          reason: 'generated-hook',
          guidance: generatedHookGuidance(generatedBy, rel),
        });
        return { ...base, repoRoot: root, hookPath: executedHookPath, hookManager: generatedBy };
      }
    }

    // The installed file first, then the declaration. The file says what is
    // there now; the declaration says what the next install will put there,
    // and on a fresh clone it is the only one of the two that exists. Either
    // alone is enough, and the refusal is the same either way: only the
    // opening sentence of the guidance changes, so a reader is told which of
    // the two was actually seen.
    //
    // This is checked only on the native path, and only where git actually
    // runs .git/hooks. BOTH conditions are about the same fact: these two
    // managers write .git/hooks/pre-commit directly and neither one reads
    // core.hooksPath. Under husky, and under any other configured hooks
    // directory, the file they rewrite is not the file git runs, so the
    // umbrella's hook is in no danger from them and a refusal would name a
    // file the manager never touches while blocking an install that is
    // perfectly safe.
    const fromHook = executedHook === undefined ? null : detectManagedHook(executedHook);
    const declared: ManagedDeclaration | null =
      fromHook === null
        ? declaredManagedHooks(root)
        : { manager: fromHook, detectedIn: { kind: 'hook' } };
    const managedBy = hooks.isDefault ? declared : null;
    if (managedBy !== null) {
      conflicts.push({
        path: rel,
        reason: 'managed-hooks',
        guidance: managedHooksGuidance(managedBy.manager, rel, managedBy.detectedIn),
      });
      return {
        ...base,
        repoRoot: root,
        hookPath: executedHookPath,
        hookManager: managedBy.manager,
      };
    }
  }

  const hookManager: HookManager = husky ? 'husky' : 'native';
  const hookPath = huskyDir === null ? executedHookPath : path.join(huskyDir, 'pre-commit');
  const relHook = path.relative(root, hookPath).split(path.sep).join('/');
  const policyPath = path.join(root, POLICY_FILE_NAME);
  const manifestPath = path.join(root, MANIFEST_RELATIVE_PATH);

  // Under husky this is the TRACKED file, never the dispatcher: reading the
  // dispatcher reported a real gate hook as foreign, which is exactly what
  // made --adopt unable to adopt it.
  const existingHook = readIfExists(hookPath);
  let adoptedFrom: AdoptedHook | null = null;

  if (existingHook !== undefined && existingHook.includes(MANAGED_HOOK_MARKER)) {
    // The marker alone used to end the matter, and that was a bug with a
    // long fuse. A hook an OLDER conductor wrote carries the same marker, so
    // it was skipped for ever: it kept running that version's command line
    // after the hook text changed, and it never entered the new manifest, so
    // a later --revert walked past it and left it behind. What the marker
    // actually settles is whose hook this is, not which version of it, so
    // the digest has to decide the rest.
    const installed = sha256(existingHook);
    const recorded = recordedHookSha(root);
    if (installed === sha256(HOOK)) {
      // Nothing to WRITE for the hook. The policy file is still checked
      // below, so a repository whose policy file was deleted can get it
      // back, and the manifest gets the same treatment: a hook that is
      // already exactly right but is missing from the manifest has to be
      // recorded, or --revert has no record that the hook is the
      // umbrella's, reports success, and leaves it running. A git clean, a
      // deleted .guardrails directory and an install from before there were
      // manifests all land in that state.
      if (recorded === installed) {
        actions.push({
          kind: 'skip',
          path: relHook,
          detail: 'already installed by conductor init',
        });
      } else {
        actions.push({
          kind: 'skip',
          path: relHook,
          detail: 'already installed, and recorded in the manifest, which had lost it',
        });
        records.push({ path: hookPath, content: existingHook, kind: 'hook' });
      }
    } else if (installed === recorded) {
      // On disk it is exactly what the manifest says a previous init wrote,
      // so nobody has touched it since and it is the umbrella's to replace.
      actions.push({
        kind: 'write',
        path: relHook,
        detail: 'update: the installed hook is from an older conductor',
      });
      writes.push({ path: hookPath, content: HOOK, executable: true, kind: 'hook' });
    } else if (options.force) {
      actions.push({
        kind: 'write',
        path: relHook,
        detail: 'replace (--force, the managed hook had been edited)',
      });
      writes.push({ path: hookPath, content: HOOK, executable: true, kind: 'hook' });
    } else {
      // It matches neither this version's hook nor the recorded one, which
      // includes the case where there is no manifest to check against. The
      // marker says it started as ours; the digest says it is not any more,
      // and an edited hook is somebody's working setup whatever comment sits
      // at the top of it.
      conflicts.push({
        path: relHook,
        reason: 'changed-since-init',
        guidance: editedManagedGuidance(relHook),
      });
      return { ...base, repoRoot: root, hookPath, hookManager };
    }
  } else if (existingHook !== undefined && existingHook.trim().length > 0) {
    const gateProduct = detectGateHook(existingHook);
    if (gateProduct === null) {
      conflicts.push({ path: relHook, reason: 'foreign-hook', guidance: foreignGuidance(relHook) });
      return { ...base, repoRoot: root, hookPath, hookManager };
    }
    if (!options.adopt) {
      conflicts.push({
        path: relHook,
        reason: 'gate-hook',
        guidance: gateHookGuidance(gateProduct, relHook),
      });
      return { ...base, repoRoot: root, hookPath, hookManager };
    }
    adoptedFrom = { product: gateProduct, content: existingHook };
    actions.push({
      kind: 'write',
      path: relHook,
      detail: `adopt: replace ${gateProduct}'s own hook (restored by --revert)`,
    });
    writes.push({ path: hookPath, content: HOOK, executable: true, kind: 'hook' });
  } else {
    const created = existingHook === undefined ? 'create' : 'replace an empty file';
    actions.push({
      kind: 'write',
      path: relHook,
      // Say the redirect out loud in --dry-run: somebody reading it in a
      // husky repository is entitled to know why the path on screen is not
      // the one core.hooksPath points at. The shim's state is reported
      // here, where it informs, rather than tested in the rule, where it
      // would send a cleaned repository back into the trap.
      detail: husky
        ? `${created}: husky runs ${path
            .relative(root, executedHookPath)
            .split(path.sep)
            .join('/')}, which execs this tracked file${
            huskyShimPresent(hooks.dir)
              ? ''
              : ' (husky is not installed right now: its generated directory is empty or gone, and the next install restores it)'
          }`
        : created,
    });
    writes.push({ path: hookPath, content: HOOK, executable: true, kind: 'hook' });
  }

  const existingPolicy = readIfExists(policyPath);
  if (existingPolicy === undefined) {
    writes.push({
      path: policyPath,
      content: renderPolicy(detectGates(root, options.pathValue)),
      executable: false,
      kind: 'policy',
    });
    actions.push({ kind: 'write', path: POLICY_FILE_NAME, detail: 'create' });
  } else {
    // Never rewritten. The policy file is the one artifact a user edits by
    // hand, and re-running init must not have an opinion about their edits.
    actions.push({
      kind: 'skip',
      path: POLICY_FILE_NAME,
      detail: 'already present, left exactly as it is',
    });
  }

  // A record with nothing to write is still work: the manifest has to be
  // rebuilt, so this is not an "already installed, nothing to do" run.
  const alreadyInstalled = writes.length === 0 && records.length === 0;
  if (!alreadyInstalled) {
    actions.push({ kind: 'write', path: MANIFEST_RELATIVE_PATH, detail: 'record what init wrote' });
  }

  return {
    ...base,
    ok: true,
    alreadyInstalled,
    hookPath,
    hookManager,
    repoRoot: root,
    adoptedFrom,
    writes,
    records,
  };
}

export function applyInit(plan: InitResult, options: InitOptions): InitResult {
  if (!plan.ok || plan.dryRun || plan.alreadyInstalled) {
    return plan;
  }

  // What a previous init recorded. An upgrade rewrites the hook and nothing
  // else, so a manifest built purely from this run's writes would forget the
  // policy file it wrote last time, and would forget the gate hook --adopt
  // replaced -- and the manifest is the only copy of that hook anywhere, so
  // forgetting it makes the gate's own hook unrestorable.
  const previous = readManifest(plan.repoRoot);

  const manifest: Manifest = {
    version: 1,
    files: [],
    adopted:
      plan.adoptedFrom === null
        ? (previous?.adopted ?? null)
        : {
            path: plan.hookPath,
            content: plan.adoptedFrom.content,
            product: plan.adoptedFrom.product,
          },
  };

  // Contain every path before writing, the same rule revert applies. These
  // paths are computed by planning rather than read straight from the manifest,
  // but the adopted record is carried forward from the committed manifest, and
  // a write that lands outside the repository is a write apply should refuse
  // whatever produced the path.
  const escaping = [
    ...plan.writes.map((write) => write.path),
    ...(manifest.adopted === null ? [] : [manifest.adopted.path]),
  ].filter((candidate) => !manifestPathInsideRepo(plan.repoRoot, candidate));
  if (escaping.length > 0) {
    return {
      ...plan,
      ok: false,
      conflicts: [
        ...plan.conflicts,
        ...escaping.map((candidate) => ({
          path: candidate,
          reason: 'manifest-path-outside-repository' as const,
          guidance:
            `${candidate} resolves outside this repository, so nothing was written. Apply ` +
            'contains every path it writes to the repository.',
        })),
      ],
    };
  }

  try {
    for (const write of plan.writes) {
      mkdirSync(path.dirname(write.path), { recursive: true });
      writeFileSync(write.path, write.content, 'utf8');
      if (write.executable) {
        // Set after the write rather than through the write's mode option:
        // an existing file keeps its own mode when written through, and git
        // will not run a hook it cannot execute. A hook that silently never
        // runs is indistinguishable from no gate at all.
        chmodSync(write.path, (statSync(write.path).mode & 0o777) | 0o755);
      }
      manifest.files.push({ path: write.path, sha256: sha256(write.content), kind: write.kind });
    }

    // Files already correct on disk that the manifest had lost. Nothing is
    // written for these; the entry is the whole point.
    for (const record of plan.records) {
      manifest.files.push({
        path: record.path,
        sha256: sha256(record.content),
        kind: record.kind,
      });
    }

    // Everything a previous init recorded and this one did not rewrite. The
    // fresh entries come first so the newly written digests are what a
    // reader sees at the top of the file.
    const rewritten = new Set([
      ...plan.writes.map((write) => write.path),
      ...plan.records.map((record) => record.path),
    ]);
    for (const file of previous?.files ?? []) {
      if (!rewritten.has(file.path)) {
        manifest.files.push(file);
      }
    }

    const manifestPath = path.join(plan.repoRoot, MANIFEST_RELATIVE_PATH);
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (err) {
    return {
      ...plan,
      ok: false,
      conflicts: [
        ...plan.conflicts,
        {
          path: plan.repoRoot,
          reason: 'write-failed',
          guidance: `Could not finish writing: ${(err as Error).message}`,
        },
      ],
    };
  }

  void options;
  return plan;
}

export interface RevertResult {
  ok: boolean;
  actions: InitAction[];
  conflicts: InitConflict[];
  /**
   * A dry run planned the revert and touched nothing. The actions describe
   * what it WOULD have removed or restored, and `ok` is what the same revert
   * would have returned for real, so `--revert --dry-run` exits the way the
   * revert it previews would.
   */
  dryRun: boolean;
}

/**
 * Removes exactly what init wrote, and nothing else.
 *
 * A file whose contents no longer match what the manifest recorded is left
 * alone and reported, because that file is now the user's whatever it
 * started as, and a revert that deletes edited work is a revert nobody runs
 * twice. Three rules follow from that, and all three were bugs here first:
 *
 *  1. IF THE HOOK SURVIVES, NOTHING IS REMOVED. Removing the policy file
 *     while leaving an edited hook in place leaves that hook running the
 *     umbrella with nothing to read, so every commit afterwards is refused
 *     with exit 2 -- while revert reported success. The hook is the piece
 *     that depends on the rest, so it decides whether a revert can proceed
 *     at all.
 *
 *  2. THE MANIFEST OUTLIVES A PARTIAL REVERT. It is deleted only once it
 *     holds nothing, because it is the only record of what is left AND, after
 *     an --adopt, the only copy of the gate hook that was replaced. Deleting
 *     it while that content was still needed made the gate's own hook
 *     unrecoverable.
 *
 *  3. A PARTIAL REVERT IS NOT A SUCCESS. It returns ok: false, so the exit
 *     code is non-zero and a script does not read "some of it" as "all of it".
 *
 * `--force` removes a changed file anyway, restoring adopted content if
 * there is any. It is the deliberate way out of every state above.
 */
export function revertInit(options: InitOptions): RevertResult {
  const actions: InitAction[] = [];
  const conflicts: InitConflict[] = [];
  const force = Boolean(options.force);
  // A dry run runs every read and every decision and skips only the writes,
  // so what it reports is exactly what a real revert from the same state would
  // do. The CLI routed --revert past --dry-run and revertInit had no branch
  // for it, so the flag whose help promised it would write nothing performed a
  // real destructive revert.
  const dryRun = Boolean(options.dryRun);

  const root = repoRootOf(options.cwd);
  if (root === null) {
    conflicts.push({
      path: '.git',
      reason: 'not-a-git-repository',
      guidance: 'Nothing to revert: this is not a git repository.',
    });
    return { ok: false, actions, conflicts, dryRun };
  }

  const manifestPath = path.join(root, MANIFEST_RELATIVE_PATH);
  const raw = readIfExists(manifestPath);
  if (raw === undefined) {
    conflicts.push({
      path: MANIFEST_RELATIVE_PATH,
      reason: 'no-manifest',
      guidance:
        `No ${MANIFEST_RELATIVE_PATH}, so there is no record of what init wrote. Nothing was ` +
        "removed: guessing which files were ours is how a revert deletes somebody's work.",
    });
    return { ok: false, actions, conflicts, dryRun };
  }

  // Not routed through readManifest, which answers null for both a missing
  // file and an unparseable one. Revert has to tell those apart: a missing
  // manifest means there is no record to act on, an unreadable one means the
  // record exists and cannot be trusted, and the second is a file somebody
  // has to look at by hand.
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch {
    conflicts.push({
      path: MANIFEST_RELATIVE_PATH,
      reason: 'manifest-unreadable',
      guidance:
        `${MANIFEST_RELATIVE_PATH} will not parse, so there is no usable record of what init ` +
        'wrote. Nothing was removed and nothing was guessed. Repair the file by hand if you ' +
        'know what belongs in it. If init ran with --adopt, this file holds the only copy of ' +
        'the hook that --adopt replaced, so recover that content from it before deleting ' +
        'anything. Only then delete it and remove the hook and the policy file yourself, and ' +
        're-run init.',
    });
    return { ok: false, actions, conflicts, dryRun };
  }

  const relative = (file: string): string => path.relative(root, file).split(path.sep).join('/');

  // The manifest is committed input, so every path it names is contained to
  // the repository before anything is written or deleted. A crafted manifest
  // could otherwise make revert delete a file anywhere on disk, or, through
  // adopted.path, write an executable one anywhere, and exit 0. Refused as a
  // whole rather than skipped one path at a time: a manifest with a path that
  // escapes is a manifest nothing should act on.
  const escaping = [
    ...manifest.files.map((file) => file.path),
    ...(manifest.adopted === null ? [] : [manifest.adopted.path]),
  ].filter((candidate) => !manifestPathInsideRepo(root, candidate));
  if (escaping.length > 0) {
    for (const candidate of escaping) {
      conflicts.push({
        path: relative(candidate),
        reason: 'manifest-path-outside-repository',
        guidance:
          `${candidate} is recorded in ${MANIFEST_RELATIVE_PATH} but resolves outside this ` +
          'repository, so nothing was written or removed. The manifest is a committed file, and ' +
          'a path in it that points out of the repository is not one revert will act on. Repair ' +
          'or delete the manifest by hand.',
      });
    }
    return { ok: false, actions, conflicts, dryRun };
  }

  // Classify first, act second. Deciding as it goes is what let the old
  // version remove the policy file before discovering it could not remove
  // the hook.
  type State = 'gone' | 'match' | 'changed';
  const planned = manifest.files.map((file) => {
    const current = readIfExists(file.path);
    const state: State =
      current === undefined ? 'gone' : sha256(current) === file.sha256 ? 'match' : 'changed';
    return { file, state };
  });

  const blockedHook = planned.find(
    (entry) => entry.file.kind === 'hook' && entry.state === 'changed'
  );

  if (blockedHook !== undefined && !force) {
    const rel = relative(blockedHook.file.path);
    conflicts.push({
      path: rel,
      reason: 'changed-since-init',
      guidance:
        `${rel} has changed since init wrote it, so nothing was removed. Removing the policy ` +
        'file while this hook stays in place would leave it running the umbrella with nothing ' +
        `to read, and every commit would be refused. Re-run with --force to remove ${rel} anyway ` +
        '(any adopted hook is restored), or delete it by hand and re-run.',
    });
    for (const entry of planned) {
      actions.push({
        kind: 'skip',
        path: relative(entry.file.path),
        detail: entry.state === 'changed' ? 'changed since init, left alone' : 'left alone',
      });
    }
    return { ok: false, actions, conflicts, dryRun };
  }

  const remaining: ManifestFile[] = [];

  for (const { file, state } of planned) {
    const rel = relative(file.path);
    if (state === 'gone') {
      actions.push({ kind: 'skip', path: rel, detail: 'already gone' });
      continue;
    }
    if (state === 'changed' && !force) {
      actions.push({ kind: 'skip', path: rel, detail: 'changed since init, left alone' });
      conflicts.push({
        path: rel,
        reason: 'changed-since-init',
        guidance: `${rel} has changed since init wrote it and was left alone. Re-run with --force to remove it anyway.`,
      });
      remaining.push(file);
      continue;
    }
    if (!dryRun) {
      rmSync(file.path, { force: true });
    }
    actions.push({
      kind: 'remove',
      path: rel,
      detail: state === 'changed' ? 'removed (--force, it had changed)' : 'removed',
    });
  }

  // Only restore an adopted hook once the umbrella hook that replaced it is
  // actually gone. Putting the old hook back next to a hook the user has
  // since edited would give them two at one path, and the edit they asked to
  // keep is the one that gets written over.
  //
  // Read off the world rather than off a flag raised while removing. This
  // used to be a `hookRemoved` boolean, and every path that reached here with
  // a hook in the manifest had already set it, because a hook that changed
  // with no --force returns at the changed-hook check far above. So the flag
  // said what this pass INTENDED and the early return was what actually held
  // the rule, which meant a refactor that flattened that return would satisfy
  // the flag and restore a hook next to a surviving one. existsSync says what
  // is there, which is the thing the rule is about.
  const recordedHooks = planned.filter((entry) => entry.file.kind === 'hook');
  const umbrellaHookGone =
    recordedHooks.length > 0 &&
    recordedHooks.every((entry) =>
      // A dry run left the hook on disk, so existsSync would say it is still
      // there and the restore would be mispredicted. Ask the plan instead:
      // every recorded hook that reached this point is either already gone or
      // slated for removal, because a changed hook with no --force returns at
      // the blocked-hook check far above, so by here a 'changed' state means
      // --force is on.
      dryRun
        ? entry.state === 'gone' || entry.state === 'match' || force
        : !existsSync(entry.file.path)
    );

  let adopted = manifest.adopted;
  if (adopted !== null && umbrellaHookGone) {
    if (!dryRun) {
      mkdirSync(path.dirname(adopted.path), { recursive: true });
      writeFileSync(adopted.path, adopted.content, 'utf8');
      chmodSync(adopted.path, 0o755);
    }
    actions.push({
      kind: 'restore',
      path: relative(adopted.path),
      detail: `restored ${adopted.product}'s own hook`,
    });
    adopted = null;
  }

  if (remaining.length === 0 && adopted === null) {
    if (!dryRun) {
      rmSync(manifestPath, { force: true });
    }
    actions.push({ kind: 'remove', path: MANIFEST_RELATIVE_PATH, detail: 'removed' });
    const manifestDir = path.dirname(MANIFEST_RELATIVE_PATH);
    const dirWouldBeEmpty = (): boolean =>
      readdirSync(path.dirname(manifestPath)).every(
        (entry) => path.join(path.dirname(manifestPath), entry) === manifestPath
      );
    if (dryRun) {
      // A dry run cannot rmdir to find out whether the directory would be
      // empty, so it looks: with the manifest gone, is anything else left?
      actions.push(
        dirWouldBeEmpty()
          ? { kind: 'remove', path: manifestDir, detail: 'removed, it was empty' }
          : {
              kind: 'skip',
              path: manifestDir,
              detail: 'kept: it holds something else, which is not ours to remove',
            }
      );
    } else {
      try {
        // rmdirSync, not rmSync: rmSync on a directory without recursive: true
        // throws before it removes anything, so this swallowed its own error
        // every time and left an empty .guardrails behind after a revert that
        // said it had removed everything. rmdirSync removes an empty directory
        // and refuses a non-empty one, which is exactly the rule wanted here.
        rmdirSync(path.dirname(manifestPath));
        actions.push({ kind: 'remove', path: manifestDir, detail: 'removed, it was empty' });
      } catch {
        // The directory holds something else, so it stays. Reported rather
        // than passed over: a directory this tool created and then left
        // behind, with nothing said about it, reads as something revert
        // forgot rather than as something it decided.
        actions.push({
          kind: 'skip',
          path: manifestDir,
          detail: 'kept: it holds something else, which is not ours to remove',
        });
      }
    }
    return { ok: true, actions, conflicts, dryRun };
  }

  // Something is left, so the manifest stays and keeps describing it.
  if (!dryRun) {
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, files: remaining, adopted }, null, 2)}\n`,
      'utf8'
    );
  }
  actions.push({
    kind: 'skip',
    path: MANIFEST_RELATIVE_PATH,
    detail: 'kept: it still records what was left behind',
  });
  return { ok: false, actions, conflicts, dryRun };
}

export function renderInitHuman(result: InitResult): string {
  const lines: string[] = [];

  if (result.conflicts.length > 0) {
    lines.push('conductor init: nothing was written.');
    for (const conflict of result.conflicts) {
      lines.push(`  ${conflict.path} (${conflict.reason})`);
      lines.push(`    ${conflict.guidance}`);
    }
    return lines.join('\n');
  }

  if (result.alreadyInstalled) {
    lines.push('conductor init: already installed; nothing to do.');
  } else {
    lines.push(
      result.dryRun ? 'conductor init (dry run): would write' : 'conductor init: wrote'
    );
  }
  for (const action of result.actions) {
    const verb = action.kind === 'skip' ? 'skip' : result.dryRun ? 'would write' : 'wrote';
    lines.push(`  ${verb} ${action.path} (${action.detail})`);
  }
  // Two different answers, and saying only the second one is wrong about the
  // hook this command just wrote. The pre-commit hook runs `conductor run
  // --staged --stage commit` with no --trust-base, and policyForRun reads the
  // working tree when trustBase is undefined, so the hook honours this file on
  // the very next commit. A pull request is the opposite: it is judged by the
  // base branch's own copy, never by the one it is proposing, so the first
  // pull request after adoption is inert and reports could-not-run. Said once,
  // here, at the point of use, rather than left for somebody to discover from
  // a could-not-run comment on their first pull request.
  lines.push(
    `Note: the pre-commit hook uses ${POLICY_FILE_NAME} from your working tree right away. ` +
      'On a pull request conductor reads it from the base branch instead, so pull requests ' +
      'report could-not-run until this file is merged there.'
  );
  return lines.join('\n');
}

export function renderRevertHuman(result: RevertResult): string {
  const removed = result.actions.filter((action) => action.kind === 'remove').length;
  const lines: string[] = [
    removed === 0
      ? 'conductor init --revert: nothing was removed.'
      : 'conductor init --revert: partly done, see below.',
  ];

  if (result.ok) {
    lines[0] = 'conductor init --revert:';
  }

  if (result.dryRun) {
    // Every action here is what a real revert WOULD do, so the header and the
    // verbs say so, and the summary above is rewritten: nothing was removed
    // because nothing is ever removed on a dry run.
    lines[0] =
      removed === 0
        ? 'conductor init --revert (dry run): would remove nothing.'
        : 'conductor init --revert (dry run): would change the files below, and write nothing now.';
  }

  for (const action of result.actions) {
    const verb = result.dryRun && action.kind !== 'skip' ? `would ${action.kind}` : action.kind;
    lines.push(`  ${verb} ${action.path} (${action.detail})`);
  }

  // The conflicts go LAST rather than first, so the thing the user has to
  // act on is the last line on their terminal rather than scrolled off the
  // top behind a list of what did work.
  for (const conflict of result.conflicts) {
    lines.push('', `  ${conflict.path} (${conflict.reason})`, `    ${conflict.guidance}`);
  }
  return lines.join('\n');
}
