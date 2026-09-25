#!/usr/bin/env node
// Wiring around scripts/lib/release-kind.mjs: arguments in, an npm lookup, a
// GITHUB_OUTPUT line out. Every DECISION lives in that module, which is what
// scripts/tests/release-kind.test.mjs exercises; this file is the part that
// talks to the filesystem, the registry and the runner.
//
//   node scripts/classify-release-tag.mjs \
//     [--tag v0.4.1] \
//     --package-name @vaultcompass/conductor --package-version 0.4.0 \
//     [--action-yml action.yml] [--changelog CHANGELOG.md]
//
// Omit --tag for a workflow_dispatch run, which has no tag.
//
// Output, appended to $GITHUB_OUTPUT when it is set:
//   action_only=true|false
//
// Exits non-zero, printing the reason, on anything that is neither a package
// release nor a valid action-only release. That refusal is the feature: the
// caller must never be able to treat an unclassifiable tag as the quieter of
// the two options.

import { readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { classifyRelease } from './lib/release-kind.mjs';

const FLAGS = ['--tag', '--package-name', '--package-version', '--action-yml', '--changelog'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!FLAGS.includes(arg)) {
      // Refused rather than ignored, for the reason the whole family now
      // shares: a silently dropped argument turns a typo into a quieter run.
      process.stderr.write(`classify-release-tag: unknown argument ${arg}\n`);
      process.exit(2);
    }
    const value = argv[i + 1];
    if (value === undefined || FLAGS.includes(value)) {
      process.stderr.write(`classify-release-tag: ${arg} needs a value\n`);
      process.exit(2);
    }
    out[arg.slice(2)] = value;
    i += 1;
  }
  return out;
}

// `npm view <name>@<version> version` answers with the version when it exists
// and empty when it does not. Anything else (network failure, a registry that
// will not answer) throws, and the caller treats that as "not published",
// which fails closed: an action-only tag we cannot confirm is published does
// not get to cut a Release describing it.
function publishedVersion(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() === '' ? null : out.trim().split('\n').pop().trim();
  } catch {
    return null;
  }
}

function readIfPresent(path) {
  if (path === undefined) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));

if (!args['package-name'] || !args['package-version']) {
  process.stderr.write('classify-release-tag: --package-name and --package-version are required\n');
  process.exit(2);
}

let result;
try {
  result = classifyRelease({
    tagName: args.tag ?? null,
    refDescription: args.tag ? `at tag ${args.tag}` : 'on a workflow_dispatch run',
    packageName: args['package-name'],
    packageVersion: args['package-version'],
    actionYmlText: readIfPresent(args['action-yml'] ?? 'action.yml'),
    changelogText: readIfPresent(args.changelog ?? 'CHANGELOG.md'),
    publishedVersion,
  });
} catch (err) {
  process.stderr.write(`::error::${err.message}\n`);
  process.exit(1);
}

process.stdout.write(
  result.actionOnly
    ? `Action-only release: the tag moves, ${args['package-name']}@${args['package-version']} stays on the registry as it is. Nothing will be published.\n`
    : `Package release: publishing ${args['package-name']}@${args['package-version']}.\n`
);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `action_only=${result.actionOnly}\n`);
}
