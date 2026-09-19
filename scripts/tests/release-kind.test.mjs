// The rules that decide whether a pushed tag publishes to npm.
//
// WHY THIS EXISTS. The release workflow knew exactly one shape: the tag must
// read "v" plus the package version. That is right for a package release and
// wrong for an ACTION-ONLY one, where action.yml, the README, the CHANGELOG
// and the docs move while the published package does not. The sibling
// repositories hit this first: dep-guard's v0.6.1 tag went red before install,
// build or publish, and its Release page had to be made by hand.
//
// The property the old assertion bought has to survive admitting the second
// shape: A MISTYPED OR MIS-POINTED TAG MUST NEVER PUBLISH ANYTHING, and a
// GitHub Release must never describe a version nobody can install. So an
// action-only tag is a CANDIDATE that has to clear every condition below, and
// anything that fails one is a mistake rather than a quieter kind of release.
//
// Ported from dep-guard, with its lockstep check dropped (this repository
// publishes one package, not two) and its action-default check pointed at the
// `conductor-version` input.

import { describe, expect, test } from '@jest/globals';
import { classifyRelease, parseExactSemver, compareExactSemver, readActionVersionDefault } from '../lib/release-kind.mjs';

// All four `-version` inputs, at the real file's indentation, because the
// classifier now reads every one of them. Three of the descriptions refer to
// `conductor-version` by name on purpose: that is the shape a loose regex
// lands in, reading the NEXT input's default instead of the intended one.
const ACTION_YML = `
inputs:
  conductor-version:
    description: >-
      The exact version of the umbrella this action installs and runs.
    default: 0.4.0
  dep-guard-version:
    description: Same rule as conductor-version.
    default: 0.6.0
  vault-guard-version:
    description: Same rule as conductor-version.
    default: 1.7.0
  intent-guard-version:
    description: Same rule as conductor-version.
    default: 1.4.0
`;

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.4.1] - 2026-09-18

An action-only release.

## [0.4.0] - 2026-09-06
`;

// Every call needs the same scaffolding; only the interesting field varies.
function classify(overrides = {}) {
  return classifyRelease({
    tagName: 'v0.4.1',
    refDescription: 'at the tagged commit',
    packageName: '@vaultcompass/conductor',
    packageVersion: '0.4.0',
    actionYmlText: ACTION_YML,
    changelogText: CHANGELOG,
    // "Everything is published": echoes the version asked for. The classifier
    // now looks up all four packages, so a stub returning one fixed string
    // would fail three of them for the wrong reason. Tests that want a
    // particular package unpublished override this and say which.
    publishedVersion: (_name, version) => version,
    ...overrides,
  });
}

describe('parseExactSemver', () => {
  test('takes an exact version and nothing else', () => {
    expect(parseExactSemver('0.4.0')).toEqual([0, 4, 0]);
    expect(parseExactSemver('10.20.30')).toEqual([10, 20, 30]);
    // A leading zero is not semver, so npm reads the spec as a dist-tag; a
    // prerelease or build suffix is a version this release path will not ship.
    for (const bad of ['01.2.3', '1.2', '1.2.3-rc.1', '1.2.3+build.5', 'v1.2.3', 'latest', '']) {
      expect([bad, parseExactSemver(bad)]).toEqual([bad, null]);
    }
  });
});

describe('compareExactSemver', () => {
  test('orders by component, never as text', () => {
    // `1.10.0` sorts below `1.7.0` as a string and above it as a version.
    expect(compareExactSemver([1, 10, 0], [1, 7, 0])).toBeGreaterThan(0);
    expect(compareExactSemver([0, 4, 0], [0, 4, 1])).toBeLessThan(0);
    expect(compareExactSemver([0, 4, 1], [0, 4, 1])).toBe(0);
  });
});

describe('readActionVersionDefault', () => {
  test('reads the conductor-version default, not another input', () => {
    // Four inputs in this file end in `-version` and three of them are other
    // people's packages. Reading the wrong one would compare the umbrella
    // against a gate's version and refuse a correct release.
    expect(readActionVersionDefault(ACTION_YML)).toBe('0.4.0');
  });

  test('refuses a file it cannot read a default out of', () => {
    expect(() => readActionVersionDefault('inputs:\n  other:\n    default: 1.0.0\n')).toThrow(
      /conductor-version/
    );
  });
});

describe('classifyRelease, package releases', () => {
  test('a tag equal to the package version is a package release', () => {
    expect(classify({ tagName: 'v0.4.0' })).toEqual({ actionOnly: false });
  });

  test('a workflow_dispatch run with no tag is a package release', () => {
    // The branch guard in the job is what keeps a dispatch on main; there is
    // no tag here to classify.
    for (const empty of [null, undefined, '']) {
      expect(classify({ tagName: empty })).toEqual({ actionOnly: false });
    }
  });

  test('a package release still checks the action default', () => {
    // A package release that left the action default behind would ship an
    // action installing a version this release is about to supersede.
    expect(() =>
      classify({ tagName: 'v0.4.0', actionYmlText: ACTION_YML.replace('0.4.0', '0.3.0') })
    ).toThrow(/default/);
  });
});

describe('classifyRelease, action-only candidates', () => {
  test('a tag ahead of the package version, written down and published, is action-only', () => {
    expect(classify()).toEqual({ actionOnly: true });
  });

  test('refuses a tag that is not v plus exact semver', () => {
    for (const bad of ['0.4.1', 'v0.4.1-rc.1', 'vlatest', 'v01.4.1']) {
      expect(() => classify({ tagName: bad })).toThrow();
    }
  });

  test('refuses a tag at or below the package version', () => {
    // A tag behind the packages is a mistyped or mis-pointed tag, never a
    // deliberate action-only release.
    for (const bad of ['v0.3.9', 'v0.1.0']) {
      expect(() => classify({ tagName: bad })).toThrow(/greater than/);
    }
  });

  test('refuses a tag with no CHANGELOG entry', () => {
    // THE CONDITION THAT SEPARATES A RELEASE FROM A FORGOTTEN BUMP. Every
    // other condition is satisfied by packages left behind and a tag pushed
    // in the belief that they had moved. What distinguishes a real
    // action-only release is that somebody wrote the entry.
    expect(() => classify({ changelogText: CHANGELOG.replace('## [0.4.1]', '## [9.9.9]') })).toThrow(
      /CHANGELOG/
    );
  });

  test('refuses when the CHANGELOG could not be read at all', () => {
    expect(() => classify({ changelogText: null })).toThrow(/CHANGELOG/);
  });

  test('refuses when the package version is not on the registry', () => {
    // An action-only tag ships a scanner that is already published. Without
    // this, its Release page would describe a version nobody can install.
    expect(() => classify({ publishedVersion: () => null })).toThrow(/registry/);
    expect(() => classify({ publishedVersion: () => '0.3.0' })).toThrow(/registry/);
  });

  test('refuses when a GATE pin names a version that is not published', () => {
    // THE HOLE THIS CLOSES. The registry check used to cover the conductor
    // package and nothing else, but in this repository the action's substance
    // IS the four `-version` pins, and moving them is the main reason an
    // action-only release exists at all. So a tag that bumped a gate pin ahead
    // of that gate's own publish classified as action-only, got a green run
    // and a Release page, and every consumer of that tag then failed at
    // `npm install -g @vaultcompass/vault-guard@<unpublished>`.
    //
    // That is precisely "a GitHub Release describing a version nobody can
    // install", which is the property this module's header claims to keep.
    // It held for one of four pins.
    const unpublishedGate = ACTION_YML.replace('default: 0.6.0', 'default: 99.99.99');
    expect(() =>
      classify({
        actionYmlText: unpublishedGate,
        publishedVersion: (name, version) =>
          name === '@vaultcompass/dep-guard' && version === '99.99.99' ? null : version,
      })
    ).toThrow(/dep-guard/);
  });

  test('checks every gate pin, not just the first one it finds', () => {
    // A loop that stopped at the first hit would pass a tree whose LAST pin is
    // the broken one.
    expect(() =>
      classify({
        publishedVersion: (name, version) =>
          name === '@vaultcompass/conductor' ? version : null,
      })
    ).toThrow(/registry/);
  });

  test('refuses when the action default moved but the package did not', () => {
    // A moved default means the scanner changed, which is a package release
    // whose package was never bumped.
    expect(() =>
      classify({ actionYmlText: ACTION_YML.replace('default: 0.4.0', 'default: 0.5.0') })
    ).toThrow(/default/);
  });

  test('never returns actionOnly for a tag that failed any condition', () => {
    // The whole point: a failing candidate throws rather than degrading into
    // a quieter release. If any of these returned instead, a mistyped tag
    // would cut a Release describing something that does not exist.
    const failures = [
      { tagName: 'v0.3.0' },
      { changelogText: '# Changelog\n' },
      { publishedVersion: () => null },
    ];
    for (const override of failures) {
      let threw = false;
      try {
        classify(override);
      } catch {
        threw = true;
      }
      expect([JSON.stringify(override), threw]).toEqual([JSON.stringify(override), true]);
    }
  });
});
