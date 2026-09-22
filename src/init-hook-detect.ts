import { statSync } from 'node:fs';
import path from 'node:path';

import type { Product } from './policy.js';
import { MANIFEST_RELATIVE_PATH, readIfExists } from './init-manifest.js';

/** The one string that says "conductor init wrote this". */
export const MANAGED_HOOK_MARKER = 'guardrails-managed-hook: v1';

/**
 * Markers each gate's own installer writes, so a collision is recognised
 * rather than clobbered. Two of these are literal marker comments the other
 * tools write on purpose; the third has no marker at all and is matched on
 * the two strings its hook always contains, which is exactly how that
 * tool's own installer recognises its own hook.
 */
export const DEP_GUARD_HOOK_MARKER = 'dep-guard-managed-hook: v1';
export const INTENT_GUARD_HOOK_MARKER = 'conductor-managed-pre-commit';

/**
 * Hook managers whose installed pre-commit file is GENERATED rather than
 * written by a human. Every one of these rewrites that file on install, so
 * it is never the file the umbrella may write into.
 *
 * The same four names dep-guard's and vault-guard's inits use, so the
 * family says one thing. The difference is that those take the manager as
 * a flag, and this one detects it: the umbrella's whole job is to be run
 * once in a repository somebody else already wired up.
 */
export type HookManager =
  | 'native'
  | 'husky'
  | 'lefthook'
  | 'precommit'
  | 'simple-git-hooks'
  | 'yorkie';

/**
 * The two managers whose pre-commit TEXT lives in package.json rather than
 * in a config file of their own or in the hook file.
 *
 * They are kept apart from lefthook and the pre-commit framework because
 * the refusal is different: there is no manager-owned config file to point
 * somebody at, only a key in the file conductor deliberately never writes.
 */
export type ManagedHookManager = 'simple-git-hooks' | 'yorkie';

/**
 * The standalone config files simple-git-hooks reads, exactly as its own
 * README lists them. yorkie has no equivalent: its config is the
 * `gitHooks` key and nothing else.
 */
const SIMPLE_GIT_HOOKS_CONFIG_FILES = [
  '.simple-git-hooks.cjs',
  '.simple-git-hooks.js',
  '.simple-git-hooks.mjs',
  '.simple-git-hooks.json',
  'simple-git-hooks.cjs',
  'simple-git-hooks.js',
  'simple-git-hooks.mjs',
  'simple-git-hooks.json',
];

/**
 * The `.husky` directory whose generated subdirectory git has been pointed
 * at, or null when this is not that arrangement.
 *
 * The rule is STRUCTURAL and nothing else: the hooks directory is named
 * `_`, and its parent is named `.husky`. Only husky creates that path, so
 * the shape alone identifies it, and both halves are required.
 *
 * Two things are deliberately NOT part of the rule, each for a reason that
 * cost a bug:
 *
 *  - THE CONTENT of the pre-commit file git executes. The line that sources
 *    husky's shim appears in two completely different places:
 *
 *      husky 9  core.hooksPath = .husky/_   .husky/_/pre-commit sources
 *               _/h and IS a dispatcher; the tracked hook is one up.
 *      husky 8  core.hooksPath = .husky     .husky/pre-commit sources
 *               _/husky.sh as a PREAMBLE and IS the tracked hook already.
 *
 *    Reading content therefore fired against husky 8's tracked hook, and
 *    "one directory up" then pointed at the parent of `.husky`, which is
 *    the repository root. Init wrote a hook there, never read the real one
 *    so never saw the gate hook in it, reported success, and left every
 *    commit ungated. The structural rule excludes husky 8 on its own,
 *    because there the hooks directory is `.husky` and not `_`.
 *
 *  - THE PRESENCE OF THE SHIM (`h`, or husky 8's `husky.sh`). Requiring it
 *    looks like useful confirmation and quietly reintroduces the original
 *    trap. husky gitignores `.husky/_`, so `git clean -xdf` deletes the
 *    whole directory while `core.hooksPath=.husky/_` sits in `.git/config`
 *    and survives. In that state there is no shim, no dispatcher, and
 *    nothing whatever to confirm, so a shim requirement sends init down the
 *    ordinary path to write `.husky/_/pre-commit` -- which is exactly the
 *    file husky's next prepare step wipes. The shim is evidence that husky
 *    ran recently, not evidence about whose directory this is, so it is
 *    reported and never tested against.
 *
 * The tracked target is this `.husky` directory's own hook, never a
 * computed parent of whatever directory git happens to point at.
 */
export function huskyDirectoryFor(hooksDir: string): string | null {
  if (path.basename(hooksDir) !== '_') {
    return null;
  }
  const huskyDir = path.dirname(hooksDir);
  if (path.basename(huskyDir) !== '.husky') {
    return null;
  }
  return huskyDir;
}

/** Whether husky's shim is in place, which is worth SAYING but never testing. */
export function huskyShimPresent(hooksDir: string): boolean {
  return isFile(path.join(hooksDir, 'h')) || isFile(path.join(hooksDir, 'husky.sh'));
}

/**
 * What each of these two managers actually writes into the hook it
 * generates, checked against a real install rather than against anybody's
 * memory of one. The captured files are in tests/fixtures/hooks.
 *
 * lefthook is recognised by `call_lefthook`, the shell function its
 * generated hook defines and then calls on the last line. Verified against
 * lefthook 2.1.12 and 1.7.18, which both write it twice.
 *
 * `lefthook_version:` is a second alternative and IS NOT VERIFIED. Neither
 * of those versions writes it, and the string does not appear anywhere in
 * the 2.1.12 binary either, so it recognises nothing lefthook produces
 * today. It stays because a spare alternative in an OR cannot cause a false
 * negative and may still catch a much older install. What could not stay is
 * the comment that used to be here, which called both halves the
 * installer's own mark: a hand-written fixture in the suite carried the
 * invented line, so the fixture and the code agreed with each other and
 * neither had ever been held up against lefthook. Recognising lefthook on
 * that string alone misclassifies both real hooks as native, which is how
 * init ends up writing into a file lefthook regenerates.
 *
 * The pre-commit framework stamps its own URL, and that one is exact:
 * verified against pre-commit 4.6.2, whose marker line is character for
 * character the string below.
 */
export function detectGeneratedHook(
  content: string
): Exclude<HookManager, 'native' | 'husky' | ManagedHookManager> | null {
  if (content.includes('call_lefthook') || content.includes('lefthook_version:')) {
    return 'lefthook';
  }
  if (content.includes('File generated by pre-commit: https://pre-commit.com')) {
    return 'precommit';
  }
  return null;
}

export function generatedHookGuidance(manager: 'lefthook' | 'precommit', relPath: string): string {
  const owner = manager === 'lefthook' ? 'lefthook' : 'the pre-commit framework';
  const config = manager === 'lefthook' ? 'lefthook-local.yml' : '.pre-commit-config.yaml';
  const stanza =
    manager === 'lefthook'
      ? 'add "conductor:" under pre-commit.commands with "run: conductor run --staged"'
      : 'add a local hook entry running "conductor run --staged" to its repos: list';
  return (
    `${relPath} is generated by ${owner}, which rewrites it on every install, so anything ` +
    `written there is lost without a word. Nothing was changed. To run the umbrella under ` +
    `${owner}, ${stanza} in ${config}. Note that ${owner} owns the commit's exit code, so the ` +
    "umbrella's 1 (a gate blocked) and 2 (a gate could not run) do not survive it."
  );
}

/**
 * The manager that generated this hook, for the two whose hook text comes
 * out of package.json. Checked against real installs, captured in
 * tests/fixtures/hooks.
 *
 * simple-git-hooks is recognised by `SKIP_SIMPLE_GIT_HOOKS`, the opt-out
 * variable its generated hook tests on its first line. Verified against
 * 2.14.0 and 2.11.1.
 *
 * IT IS NOT IN EVERY VERSION, and that is the whole reason the package.json
 * key below exists rather than being belt and braces. simple-git-hooks 2.8.0
 * writes the shebang and the user's own command and nothing else: there is
 * no string in that file belonging to simple-git-hooks, so no content rule
 * can recognise it, at any price. A repository on that version is
 * unrecognisable from its hook alone and would have had the umbrella hook
 * written into a file the next install rewrites.
 *
 * yorkie is recognised by `yorkie/src/runner.js`, the script its generated
 * hook invokes. Verified against 2.0.0, which writes it relative, and 1.0.2,
 * which writes the same suffix under an absolute path, so the suffix is what
 * both have in common. The `#yorkie ` version stamp on the second line is a
 * second alternative and is present in both captures too; it is second
 * because it is a comment, and a comment is the part of a generated file
 * most likely to be reworded.
 */
export function detectManagedHook(content: string): ManagedHookManager | null {
  if (content.includes('SKIP_SIMPLE_GIT_HOOKS')) {
    return 'simple-git-hooks';
  }
  if (content.includes('yorkie/src/runner.js') || content.includes('#yorkie ')) {
    return 'yorkie';
  }
  return null;
}

/**
 * The manager this repository's package.json DECLARES, or null.
 *
 * This is the signal that matters, and it is not a corroboration of the
 * content rule above: it is the only one that fires on a fresh clone, where
 * the manager has never run, `.git/hooks/pre-commit` does not exist, and the
 * next `npm install` will create it. That is the state a repository is in
 * when somebody adds the umbrella to it.
 *
 * Presence of the key is the whole test; it is deliberately NOT narrowed to
 * a declared `pre-commit` entry. yorkie's installer writes every hook file
 * whatever the key contains (its generated hook decides at run time whether
 * a script exists), and simple-git-hooks removes hooks it previously managed
 * as well as writing the declared ones. Narrowing would trade a refusal that
 * costs somebody one paragraph of guidance for a hook that is silently
 * deleted, and those are not the same size of mistake.
 *
 * An unreadable or unparseable package.json is the same answer as no
 * package.json: this asks whether something was declared, and "the file
 * cannot be read" is not evidence that it was.
 */
/**
 * Where a managed-hooks declaration was found.
 *
 * The config file is carried rather than collapsed into a boolean because
 * the guidance has to NAME it: simple-git-hooks reads package.json last, so
 * telling somebody to edit package.json while one of these exists sends them
 * to the file that will be ignored.
 */
export type ManagedDetection =
  | { kind: 'hook' }
  | { kind: 'package.json' }
  | { kind: 'config-file'; file: string };

export interface ManagedDeclaration {
  manager: ManagedHookManager;
  detectedIn: ManagedDetection;
}

export function declaredManagedHooks(root: string): ManagedDeclaration | null {
  // A standalone config file counts as a declaration on its own. Taken
  // verbatim from simple-git-hooks' own README, which says the config may
  // live in ".simple-git-hooks.cjs, .simple-git-hooks.js,
  // .simple-git-hooks.mjs, .simple-git-hooks.json, or
  // simple-git-hooks.{cjs,js,mjs,json}". It is an EXACT list rather than a
  // prefix or extension test, so a simple-git-hooks.yaml or a
  // simple-git-hooks.md is what it looks like -- somebody's notes -- and not
  // a reason to refuse an install.
  //
  // This is the third signal and the only one that fires for the repository
  // that has all the others against it: a standalone config plus an older
  // simple-git-hooks, whose generated hook carries no marker at all.
  // Checked BEFORE package.json, and the order is the same one
  // simple-git-hooks resolves in: it reads package.json last, so whichever
  // of these exists is the file that actually decides the hook.
  const configFile = SIMPLE_GIT_HOOKS_CONFIG_FILES.find((file) =>
    isFile(path.join(root, file))
  );
  if (configFile !== undefined) {
    return { manager: 'simple-git-hooks', detectedIn: { kind: 'config-file', file: configFile } };
  }

  const raw = readIfExists(path.join(root, 'package.json'));
  if (raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const manifest = parsed as Record<string, unknown>;
  if (isPlainObject(manifest['simple-git-hooks'])) {
    return { manager: 'simple-git-hooks', detectedIn: { kind: 'package.json' } };
  }
  if (isPlainObject(manifest.gitHooks)) {
    return { manager: 'yorkie', detectedIn: { kind: 'package.json' } };
  }
  return null;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What init says when it finds one of those two, and why it says nothing
 * else.
 *
 * The honest answer here is a refusal, not an offer. These managers have no
 * tracked hook file to redirect into and no config file of their own to name:
 * the only place the umbrella's command could go is a key in package.json,
 * and init does not write package.json. That is not squeamishness. Init
 * writes a hook, a policy file and a manifest, and the manifest is what
 * makes --revert honest; an edit merged into somebody's package.json has no
 * revert story that is not a guess about which of their later edits were
 * theirs. So the guidance says exactly what to add and leaves the adding to
 * the person whose file it is.
 *
 * The exit-code sentence differs between the two, and both halves are held
 * against the captured fixtures rather than against anybody's memory:
 * simple-git-hooks runs the entry as the last command of a plain `sh`
 * script, so the umbrella's status is the hook's status, while yorkie wraps
 * its runner in `|| { ...; exit 1; }` and turns every non-zero exit into 1.
 */
export function managedHooksGuidance(
  manager: ManagedHookManager,
  relPath: string,
  detectedIn: ManagedDetection
): string {
  // WHERE THE ENTRY GOES IS WHERE THE DECLARATION ALREADY IS.
  // simple-git-hooks reads package.json LAST, so while a standalone config
  // file exists an entry added to package.json is precisely the one it
  // ignores. Naming package.json there would send somebody to edit a file
  // that will not be read, and leave them with the umbrella uninstalled and
  // no error to explain it.
  const home = detectedIn.kind === 'config-file' ? detectedIn.file : 'package.json';
  const entry =
    detectedIn.kind === 'config-file'
      ? `the "pre-commit" entry in ${detectedIn.file}`
      : manager === 'simple-git-hooks'
        ? 'the "pre-commit" entry under "simple-git-hooks" in package.json'
        : 'the "pre-commit" entry under "gitHooks" in package.json';
  const reinstall =
    manager === 'simple-git-hooks'
      ? 're-run "npx simple-git-hooks"'
      : 're-run the install (yorkie rewrites its hooks on postinstall)';
  const exitCodes =
    manager === 'simple-git-hooks'
      ? `${manager} runs that entry as the last command of the hook it generates, so the ` +
        "umbrella's exit codes reach git unchanged: 1 means a gate blocked, 2 means a gate " +
        'could not run.'
      : `${manager}'s generated hook turns every non-zero exit into 1, so the umbrella's 2 ` +
        '(a gate could not run, and nothing was checked) reaches git as 1 (a gate blocked). ' +
        'Both still stop the commit.';
  const lead =
    detectedIn.kind === 'hook'
      ? `${relPath} was generated by ${manager} from its own declaration, and is rewritten on ` +
        'every install.'
      : `${home} declares ${manager}, which generates ${relPath} from that declaration and ` +
        'rewrites it on every install.';
  return (
    `${lead} A hook written there is gone after the next install while ` +
    `${MANIFEST_RELATIVE_PATH} still records it as installed, so the repository would report a ` +
    'guardrail it no longer has. Nothing was changed, and --force does not override this: that ' +
    `file was never conductor's to hold. To run the umbrella under ${manager}, set ${entry} ` +
    'to "conductor run --staged --stage commit" yourself, and ' +
    `${reinstall}. If something is already in that entry, put the umbrella LAST, as its own ` +
    'command rather than chained behind && : a chain stops at the first failure, so an ' +
    "umbrella in front of it hides the other command's verdict and one behind an && never " +
    `runs at all once anything ahead of it fails. conductor does not edit ${home}, so it ` +
    'cannot do that for you; a later release may offer to. ' +
    exitCodes
  );
}

export function detectGateHook(content: string): Product | null {
  if (content.includes(DEP_GUARD_HOOK_MARKER)) {
    return 'dep-guard';
  }
  // Deliberately still the pre-rename string: it is state already sitting
  // in users' repositories, and the tool that writes it did not rename it
  // either, precisely so an older hook stays recognisable.
  if (content.includes(INTENT_GUARD_HOOK_MARKER)) {
    return 'intent-guard';
  }
  if (content.includes('vault-guard') && content.includes('scan --staged')) {
    return 'vault-guard';
  }
  return null;
}

/**
 * Existence as a plain file, with no opinion about the executable bit.
 * husky's shim is copied out of the package with whatever mode the tarball
 * carried, and it is sourced rather than executed, so requiring +x here
 * would make detection depend on something husky does not guarantee.
 */
function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function foreignGuidance(relPath: string): string {
  return (
    `${relPath} already exists and was not written by conductor init. Merge "conductor run --staged" ` +
    'into it yourself, or move it aside and re-run init. Init never replaces a hook it does not ' +
    "recognise, because that hook is somebody's working setup."
  );
}

export function editedManagedGuidance(relPath: string): string {
  return (
    `${relPath} carries conductor's own marker but does not match the hook this version writes, ` +
    'and either does not match the one recorded in the manifest or there is no manifest to ' +
    'check against. Either way nothing on disk says these are the contents conductor left, so ' +
    "nothing was changed: an edited hook is somebody's working setup, marker or not. Re-run " +
    'with --force to replace it anyway, or delete it by hand and re-run.'
  );
}

export function gateHookGuidance(product: Product, relPath: string): string {
  return (
    `${relPath} is ${product}'s own pre-commit hook. Adding the umbrella hook alongside it would ` +
    `run ${product} twice and report its findings twice. Re-run with --adopt to replace it with ` +
    'the umbrella hook, which runs every enabled commit-stage gate including that one, or leave ' +
    'things as they are and do not run init here.'
  );
}
