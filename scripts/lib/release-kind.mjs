// Decides whether a pushed tag is a PACKAGE release or an ACTION-ONLY one.
//
// WHY THIS EXISTS. The release workflow knew exactly one shape: the tag must
// read "v" plus the package version. That is right for a package release and
// wrong for an action-only one, where action.yml, the README, the CHANGELOG
// and the docs move while the published package does not. The action tag and
// the versions it installs are allowed to come apart, and they do the moment
// the action changes without the umbrella changing.
//
// The sibling repositories hit this first. dep-guard's v0.6.1 tag went red
// before install, build or publish; nothing was published, which was right,
// but the tag got no Release page and every future action-only tag would have
// failed the same way.
//
// THE PROPERTY THE OLD ASSERTION BOUGHT HAS TO SURVIVE ADMITTING THE SECOND
// SHAPE. A mistyped or mis-pointed tag must never publish anything, and a
// GitHub Release must never describe a version nobody can install. So an
// action-only tag is a CANDIDATE that clears every condition below, and a tag
// failing any one of them is a mistake rather than a quieter kind of release.
// That distinction is the whole reason this file is separate from the
// workflow: it is the part worth testing.
//
// Ported from dep-guard, with two deliberate differences. Its lockstep check
// is gone, because this repository publishes one package rather than two. And
// its action-default check is pointed at the `conductor-version` input, which
// matters here in a way it did not there: FOUR inputs in this action.yml end
// in `-version`, and three of them name other people's packages.

import { parse as parseYaml } from 'yaml';

/**
 * An exact version and nothing else: three numeric components, no prerelease,
 * no build suffix, no leading zeros. Returns [major, minor, patch] or null.
 *
 * Leading zeros are refused because `01.2.3` is not semver, so npm does not
 * read it as a version at all: a spec it cannot parse falls back to being
 * treated as a DIST-TAG, which is the family of thing a release path must
 * never accept.
 */
export function parseExactSemver(value) {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Orders two parsed versions. Component by component, never as text: `1.10.0`
 * sorts BELOW `1.7.0` as a string and above it as a version.
 */
export function compareExactSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The `conductor-version` input's default, read out of action.yml.
 *
 * Named explicitly rather than taken as "the first `default:` in the file".
 * Four inputs here end in `-version`, and the other three are the gates:
 * reading one of those would compare the umbrella against a gate's version
 * and refuse a correct release, or worse, accept a wrong one.
 */
export function readActionVersionDefault(actionYmlText) {
  return readInputDefault(actionYmlText, 'conductor-version');
}

/**
 * The gates this action installs alongside the umbrella, and the npm package
 * each `-version` input names.
 *
 * THESE ARE THE SUBSTANCE OF AN ACTION-ONLY RELEASE. The umbrella's own
 * version stays put by definition on such a tag; what actually moves is
 * usually one of these pins. A release that ships a pin naming an unpublished
 * version hands every consumer an action that dies at `npm install -g`, which
 * is the same failure as a Release page describing a version nobody can
 * install -- just one level down.
 */
export const GATE_INPUTS = [
  ['dep-guard-version', '@vaultcompass/dep-guard'],
  ['vault-guard-version', '@vaultcompass/vault-guard'],
  ['intent-guard-version', '@vaultcompass/intent-guard'],
];

/**
 * One input's `default:`, read by PARSING action.yml rather than by matching
 * lines in it.
 *
 * TEXT MATCHING WAS TRIED HERE TWICE AND WAS WRONG BOTH TIMES. The first shape
 * searched for the input's name anywhere in the file, which landed inside a
 * description that named another input and read the NEXT input's default. The
 * second anchored to `  <name>:` at the start of a line, which fixed that one
 * and left a worse hole: every description in this action.yml is a `>-` block
 * scalar, and a line inside such a block that happens to read `default: 1.7.0`
 * is prose, not a key, yet the line matcher took it. Prose in a description is
 * writeable by anyone editing the file, so the accept direction was reachable:
 * a stale version read out of a description, found published, while the real
 * pin naming an unpublished version went unchecked, and the Release page got
 * cut for an action that dies at `npm install -g`.
 *
 * A YAML parser knows the difference between a key and the text of a block
 * scalar, knows that `default: '1.7.0'` is the string 1.7.0, and costs nothing
 * here: `yaml` is already a dependency of this package and `tests/action.test.ts`
 * already parses this same file with it. Hand-written line parsers for YAML are
 * the bug, not the implementation detail.
 */
export function readInputDefault(actionYmlText, inputName) {
  if (typeof actionYmlText !== 'string') {
    throw new Error(`action.yml could not be read, so its ${inputName} default is unknown.`);
  }

  let document;
  try {
    document = parseYaml(actionYmlText);
  } catch (err) {
    throw new Error(
      `action.yml is not valid YAML (${err.message}), so its ${inputName} default could not be read.`
    );
  }

  const input = document?.inputs?.[inputName];
  if (input === undefined || input === null || typeof input !== 'object') {
    throw new Error(
      `action.yml has no ${inputName} input, so the version it installs could not be checked.`
    );
  }

  const value = input.default;
  if (value === undefined || value === null) {
    throw new Error(
      `action.yml's ${inputName} input has no default, so the version it installs could not be checked against the package being released.`
    );
  }

  // Stringified rather than returned raw: YAML reads an unquoted `1.7` as a
  // number, and every caller compares this against version TEXT.
  return String(value);
}

// A package release must ship an action whose default names the version being
// published, or the action would install something this release supersedes.
function assertPackageReleaseDefault({ packageVersion, actionYmlText, refDescription }) {
  const actionDefault = readActionVersionDefault(actionYmlText);
  if (actionDefault !== packageVersion) {
    throw new Error(
      `action.yml's conductor-version input defaults to ${actionDefault} while the package is at ${packageVersion} (${refDescription}). A package release ships an action that installs the version being published. Refusing to publish.`
    );
  }
}

/**
 * @returns {{actionOnly: boolean}}
 * @throws on anything that is neither a package release nor a valid
 *   action-only release. Throwing is the point: the caller must not be able to
 *   treat an unclassifiable tag as the quieter of the two options.
 */
export function classifyRelease({
  tagName,
  refDescription,
  packageName,
  packageVersion,
  actionYmlText,
  changelogText,
  publishedVersion,
}) {
  // workflow_dispatch has no tag. The branch guard in the job keeps a dispatch
  // run on main; there is nothing here to classify and a dispatch is always a
  // package release.
  //
  // .github/workflows/release.yml currently triggers on tag push ONLY, so no
  // run reaches this branch today. It is kept, and kept asserting, because it
  // is the safe direction: the day a dispatch trigger is added back, the
  // default has to be checked rather than assumed, and a branch that returned
  // without asserting would publish whatever the action pinned.
  if (tagName === null || tagName === undefined || tagName === '') {
    assertPackageReleaseDefault({ packageVersion, actionYmlText, refDescription });
    return { actionOnly: false };
  }

  // The package-release path proper. Neither this nor the dispatch case
  // consults the registry, because a package release publishes a version that
  // is by definition not on it yet.
  if (tagName === `v${packageVersion}`) {
    assertPackageReleaseDefault({ packageVersion, actionYmlText, refDescription });
    return { actionOnly: false };
  }

  // From here on this is an action-only CANDIDATE.
  const tagVersionText = tagName.startsWith('v') ? tagName.slice(1) : null;
  const tagVersion = tagVersionText === null ? null : parseExactSemver(tagVersionText);
  if (tagVersion === null) {
    throw new Error(
      `Tag ${tagName} does not match the package version ${packageVersion}, so it could only be an action-only release tag, but it is not "v" plus an exact semver version (no prerelease, no build suffix, no leading zeros). Refusing to publish.`
    );
  }

  const parsedPackageVersion = parseExactSemver(packageVersion);
  if (parsedPackageVersion === null) {
    throw new Error(
      `Tag ${tagName} does not match the package version ${packageVersion}, and that package version is not exact semver, so the two cannot be ordered against each other. Refusing to publish.`
    );
  }

  if (compareExactSemver(tagVersion, parsedPackageVersion) <= 0) {
    throw new Error(
      `Tag ${tagName} is not greater than the package version ${packageVersion} (${refDescription}). An action-only release moves the tag forward past the version it ships; a tag at or below the package version is a mistyped or mis-pointed tag. Refusing to publish.`
    );
  }

  // A RELEASE NOBODY WROTE DOWN IS A RELEASE NOBODY DECIDED TO MAKE.
  //
  // Every condition above is satisfied by a plain forgotten bump: the package
  // left at 0.4.0, "v0.5.0" pushed in the belief that it had moved. Such a tag
  // is exact semver, greater than the package version, backed by a published
  // package, and matched by an action default that never moved either. What
  // separates that stray tag from a real action-only release is that somebody
  // wrote the entry. Local, on the tagged commit's own tree, so it costs
  // nothing and runs before the registry lookup below.
  if (typeof changelogText !== 'string') {
    throw new Error(
      `Tag ${tagName} looks like an action-only release, but CHANGELOG.md could not be read at the tagged commit, so its entry could not be checked. Refusing to publish.`
    );
  }
  const headingPattern = new RegExp(`^##\\s*\\[${tagVersionText.replace(/\./g, '\\.')}\\]`, 'm');
  if (!headingPattern.test(changelogText)) {
    throw new Error(
      `Tag ${tagName} looks like an action-only release, but CHANGELOG.md at the tagged commit has no "## [${tagVersionText}]" heading. An action-only release is still a release: a tag with no entry is far more likely to be a version bump someone forgot to commit than a deliberate one. Refusing to publish.`
    );
  }

  // The condition that carries the "never describes anything unpublished"
  // property. Everything above is shape, ordering and this tree's own files;
  // this is the one that talks to the world.
  // EVERY PACKAGE THIS TAG SHIPS, not just the umbrella. The four gate pins
  // are what an action-only release usually moves, and a pin naming an
  // unpublished version hands every consumer an action that dies at
  // `npm install -g`. Checked as a list rather than one call so a pin added
  // later is covered by construction; the loop does not stop at the first hit,
  // or a tree whose LAST pin is broken would pass.
  //
  // EACH PIN IS CHECKED FOR SHAPE BEFORE IT IS LOOKED UP, because a pin of
  // `^1.0.0` or `latest` is a different mistake from a pin naming a version
  // nobody published, and only the shape check can say so. The registry
  // lookup does fail closed on a range (`npm view` resolves it and answers
  // with something other than the text asked for), but the refusal then reads
  // as a registry problem and sends whoever is unpicking it to npmjs rather
  // than to the line in action.yml that is actually wrong. It is also the
  // same family of thing `parseExactSemver` exists to refuse everywhere else
  // on this path: a spec npm cannot parse as a version is treated as a
  // dist-tag, and a dist-tag moves.
  const shipped = [[packageName, packageVersion]];
  for (const [inputName, gateName] of GATE_INPUTS) {
    const pin = readInputDefault(actionYmlText, inputName);
    if (parseExactSemver(pin) === null) {
      throw new Error(
        `Tag ${tagName} looks like an action-only release, but action.yml's ${inputName} input defaults to "${pin}", which is not an exact version (three numeric components, no prerelease, no build suffix, no leading zeros). A range or a dist-tag hands the choice of which program judges a pull request to whatever the registry serves on the morning of the run. Refusing to publish.`
      );
    }
    shipped.push([gateName, pin]);
  }

  for (const [name, version] of shipped) {
    const found = publishedVersion(name, version);
    if (found !== version) {
      throw new Error(
        `Tag ${tagName} looks like an action-only release, but ${name}@${version} is not on the npm registry (lookup returned ${
          found === null || found === undefined ? 'nothing' : `"${found}"`
        }). An action-only tag must ship versions that are already published, or consumers of that tag fail at install and its GitHub Release describes something nobody can get. Refusing to publish.`
      );
    }
  }

  const actionDefault = readActionVersionDefault(actionYmlText);
  if (actionDefault !== packageVersion) {
    throw new Error(
      `Tag ${tagName} looks like an action-only release, but action.yml's conductor-version input defaults to ${actionDefault} while the package is at ${packageVersion}. An action-only tag ships the version that is already published; a moved default means the umbrella changed, which is a package release whose package was never bumped. Refusing to publish.`
    );
  }

  return { actionOnly: true };
}
