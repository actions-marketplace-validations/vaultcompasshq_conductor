import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { Product } from './policy.js';

export const MANIFEST_RELATIVE_PATH = '.guardrails/manifest.json';

export interface ManifestFile {
  path: string;
  sha256: string;
  /**
   * What this file is to the umbrella. Recorded rather than inferred from
   * the path, because revert's whole decision turns on whether the HOOK
   * survived, and sniffing that from a filename is a guess.
   */
  kind: 'hook' | 'policy';
}

export interface Manifest {
  version: 1;
  files: ManifestFile[];
  adopted: { path: string; content: string; product: Product } | null;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Whether a path the manifest names is contained to the repository.
 *
 * The manifest is committed input, so a path in it is whatever a commit put
 * there. Revert and apply run this over every path they would write to or
 * delete before touching anything, and refuse the whole operation if any one
 * of them is not contained.
 *
 * Two conditions, because a path can escape two ways. The resolved path,
 * treated as plain strings, must be inside the root: this refuses an absolute
 * path and one that climbs out with ../. And no component of the path may be a
 * SYMLINK. A committed dangling symlink (its target does not exist) is the case
 * that broke an earlier version of this: existsSync FOLLOWS the link, finds the
 * missing target, and reports the link absent, so a walk that resolved only the
 * deepest existing ancestor judged the link a plain not-yet-existing leaf and
 * let writeFileSync and chmodSync, which DO follow the final link, land the
 * write on the outside target. lstatSync does not follow, so it catches a
 * symlink component even when its target is gone. init never writes through a
 * symlink, so a symlink anywhere along the path means this is not a path init
 * wrote, and it is refused whatever it points at.
 *
 * Paths here need not exist yet: an adopted hook is restored to a path revert
 * has just removed, and a recorded file may be legitimately gone. The scan
 * stops at the first component that does not exist, because nothing below a
 * missing component exists either, so there is no symlink left to find. A
 * relative candidate is taken against the repository root, which is how the
 * real attack lands: a person running revert has cd'd into the checkout.
 */
export function manifestPathInsideRepo(repoRoot: string, candidate: string): boolean {
  try {
    const root = realpathSync(repoRoot);
    const abs = path.resolve(root, candidate);

    // Deepest ancestor of abs that exists on disk. realpathSync on the whole
    // path throws when the leaf is not there, so resolve the part that exists
    // and keep the rest as a tail. existsSync FOLLOWS symlinks, which is why a
    // dangling symlink is not trusted here; the tail is scanned with lstatSync
    // below.
    let ancestor = abs;
    while (!existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
    const realAncestor = realpathSync(ancestor);
    const tail = path.relative(ancestor, abs);

    // Containment, on resolved paths so a macOS temp dir reached through
    // /var -> /private/var does not read as an escape, and so an existing
    // symlink directory that points outside is caught by its resolved target.
    const resolved = tail === '' ? realAncestor : path.join(realAncestor, tail);
    const inside = path.relative(root, resolved);
    if (
      inside === '' ||
      inside === '..' ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    ) {
      return false;
    }

    // No component of the tail may be a symlink. lstatSync does not follow, so
    // a committed DANGLING symlink is caught even though existsSync reported it
    // absent: existsSync followed the link to its missing target, which let an
    // earlier version treat the link as a plain not-yet-existing leaf and then
    // let writeFileSync and chmodSync, which DO follow the final link, land the
    // write on the outside target. init never writes through a symlink, so any
    // symlink component means this is not a path init wrote. The scan starts at
    // the resolved ancestor, whose own components are already real, and walks
    // to the leaf, stopping at the first component that does not exist.
    let current = realAncestor;
    for (const segment of tail === '' ? [] : tail.split(path.sep)) {
      current = path.join(current, segment);
      let entry;
      try {
        entry = lstatSync(current);
      } catch {
        break;
      }
      if (entry.isSymbolicLink()) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The manifest a previous init left, or null when there is none or it will
 * not parse.
 *
 * An unreadable manifest is deliberately the same answer as a missing one:
 * everything that consults it here is deciding whether a file on disk is
 * one the umbrella wrote, and "the record is unreadable" is not evidence
 * that it was.
 */
export function readManifest(root: string): Manifest | null {
  const raw = readIfExists(path.join(root, MANIFEST_RELATIVE_PATH));
  if (raw === undefined) {
    return null;
  }
  try {
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

/** The hook digest a previous init recorded, or null when there is none. */
export function recordedHookSha(root: string): string | null {
  return readManifest(root)?.files.find((file) => file.kind === 'hook')?.sha256 ?? null;
}
