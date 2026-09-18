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
 * Deliberately anchored to that input's own block rather than to the first
 * `default:` in the file. Four inputs here end in `-version`, and the other
 * three are the gates: reading one of those would compare the umbrella
 * against a gate's version and refuse a correct release, or worse, accept a
 * wrong one.
 */
export function readActionVersionDefault(actionYmlText) {
  if (typeof actionYmlText !== 'string') {
    throw new Error('action.yml could not be read, so its conductor-version default is unknown.');
  }
  const match = /conductor-version:[\s\S]*?\n\s*default:\s*(\S+)/.exec(actionYmlText);
  if (match === null) {
    throw new Error(
      'action.yml has no conductor-version input with a default, so the version it installs could not be checked against the package being released.'
    );
  }
  return match[1];
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
  const found = publishedVersion(packageName, packageVersion);
  if (found !== packageVersion) {
    throw new Error(
      `Tag ${tagName} looks like an action-only release, but ${packageName}@${packageVersion} is not on the npm registry (lookup returned ${
        found === null || found === undefined ? 'nothing' : `"${found}"`
      }). An action-only tag must ship a version that is already published, or its GitHub Release would describe something nobody can install. Refusing to publish.`
    );
  }

  const actionDefault = readActionVersionDefault(actionYmlText);
  if (actionDefault !== packageVersion) {
    throw new Error(
      `Tag ${tagName} looks like an action-only release, but action.yml's conductor-version input defaults to ${actionDefault} while the package is at ${packageVersion}. An action-only tag ships the version that is already published; a moved default means the umbrella changed, which is a package release whose package was never bumped. Refusing to publish.`
    );
  }

  return { actionOnly: true };
}
