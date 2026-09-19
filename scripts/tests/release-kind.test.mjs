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
import {
  classifyRelease,
  parseExactSemver,
  compareExactSemver,
  readActionVersionDefault,
  readInputDefault,
} from '../lib/release-kind.mjs';

// All four `-version` inputs, at the real file's indentation, because the
// classifier reads every one of them.
//
// THIS FIXTURE CARRIES BOTH SHAPES THAT BROKE A TEXT-MATCHING PARSER, and it
// carries them literally rather than in spirit. An earlier version of this
// file claimed to reproduce the first one with descriptions reading "Same rule
// as conductor-version." -- with a PERIOD, where the slip needs a COLON -- so
// dropping the parser back to the loose regex passed every test in here.
//
//   1. `stage`, EARLIER in the file than `conductor-version`, has the literal
//      text `conductor-version:` in its description. A parser that searches
//      for the name anywhere lands there and reads `default: ci`, which is the
//      next input's default and not a version at all.
//
//   2. `conductor-version`'s own description block contains a line reading
//      `default: 9.9.9` ABOVE its real default. That line is the text of a
//      folded block scalar, not a key, and only a YAML parser knows the
//      difference. A line matcher anchored to the input's own block still
//      takes it, which is the ACCEPT direction: a stale version that happens
//      to be published, read in place of a real pin that is not.
//
//   3. `vault-guard-version`'s default is QUOTED, because action.yml may quote
//      one at any time and `'1.7.0'` must read as `1.7.0` rather than as a
//      string with quote marks in it.
const ACTION_YML = `
inputs:
  stage:
    description: >-
      Which stopping point this job is. Stages are cumulative, so ci runs
      everything that is enabled. It is not one of the version pins; those
      are written one per line, starting with conductor-version: and
      continuing with one entry per gate.
    default: ci
  conductor-version:
    description: >-
      The exact version of the umbrella this action installs and runs. An
      exact version, never a range and never a dist-tag. An earlier draft of
      this description showed the pin inline, on a line of its own:

        default: 9.9.9

      which is prose rather than a key, however much it looks like one.
    default: 0.4.0
  dep-guard-version:
    description: Same rule as conductor-version.
    default: 0.6.0
  vault-guard-version:
    description: Same rule as conductor-version.
    default: '1.7.0'
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

describe('readInputDefault', () => {
  test('reads the real default of every input, not a line that looks like one', () => {
    // THE WHOLE FIXTURE IS THE TEST HERE. `stage` sits above
    // `conductor-version` with the literal `conductor-version:` in its
    // description, and `conductor-version`'s own description block holds a
    // line reading `default: 9.9.9` above the real one. Both are prose. A
    // parser that reads either of them returns a version this repository
    // never pinned, and on the accept side that means a Release page cut for
    // an action whose consumers die at `npm install -g`.
    expect(readInputDefault(ACTION_YML, 'stage')).toBe('ci');
    expect(readInputDefault(ACTION_YML, 'conductor-version')).toBe('0.4.0');
    expect(readInputDefault(ACTION_YML, 'dep-guard-version')).toBe('0.6.0');
    expect(readInputDefault(ACTION_YML, 'vault-guard-version')).toBe('1.7.0');
    expect(readInputDefault(ACTION_YML, 'intent-guard-version')).toBe('1.4.0');
  });

  test('reads a quoted default as the version, without its quote marks', () => {
    // action.yml is free to quote a default at any time, and a quoted version
    // compared against an unquoted package version would refuse a correct
    // release while naming a version that looks identical in the message.
    const quoted = `
inputs:
  conductor-version:
    description: The umbrella.
    default: '0.4.0'
`;
    expect(readInputDefault(quoted, 'conductor-version')).toBe('0.4.0');
    expect(readActionVersionDefault(quoted)).toBe('0.4.0');
  });

  test('refuses an input that is absent, and one that has no default', () => {
    expect(() => readInputDefault('inputs:\n  other:\n    default: 1.0.0\n', 'conductor-version')).toThrow(
      /no conductor-version input/
    );
    expect(() =>
      readInputDefault('inputs:\n  conductor-version:\n    description: No default here.\n', 'conductor-version')
    ).toThrow(/no default/);
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

  test('a workflow_dispatch run with no tag still checks the action default', () => {
    // Deleting the assertion on the no-tag path used to pass every test in
    // this file, so nothing pinned it. It is the same failure as on the
    // tagged path: an action left pinned to a version this run is about to
    // supersede.
    //
    // The workflow does not reach this branch today (release.yml triggers on
    // tag push only), which is exactly why a test has to hold it: a branch no
    // run exercises is a branch no run would catch breaking either.
    for (const empty of [null, undefined, '']) {
      expect(() =>
        classify({ tagName: empty, actionYmlText: ACTION_YML.replace('default: 0.4.0', 'default: 0.3.0') })
      ).toThrow(/default/);
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

  test('wants a real heading, not the heading text quoted inside a line', () => {
    // The heading pattern is anchored to the start of a line. Dropping that
    // anchor passed every other test in this file, and it is not a pedantic
    // difference: prose that mentions a version, which is exactly what an
    // Unreleased section is full of, would then count as somebody having
    // written the entry. That is the one condition separating a deliberate
    // action-only release from a version bump someone forgot to commit.
    const mentionOnly = `# Changelog

## [Unreleased]

Nothing yet; see ## [0.4.1] below once it is written.

## [0.4.0] - 2026-09-06
`;
    expect(() => classify({ changelogText: mentionOnly })).toThrow(/CHANGELOG/);
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

  test('refuses a gate pin that is a range or a dist-tag, and says so', () => {
    // Without the shape check this still fails closed, because the registry
    // lookup answers with something other than the text asked for. But it
    // fails closed while reading as a registry problem, which sends whoever
    // is unpicking it to npmjs instead of to the line in action.yml that is
    // wrong.
    for (const bad of ['^1.0.0', 'latest', '1.7']) {
      expect(() =>
        classify({ actionYmlText: ACTION_YML.replace("default: '1.7.0'", `default: '${bad}'`) })
      ).toThrow(/not an exact version/);
    }
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
