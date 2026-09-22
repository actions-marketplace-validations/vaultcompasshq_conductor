// Drift check for the load-bearing hardening in action.yml.
//
// The install suite runs the step and checks what npm was asked. That can
// stay green while the source of the step drifts: a second, weaker copy of
// the version shape, a floor comment that no longer matches the comparison,
// or an install that dropped --ignore-scripts and grew a lookalike later.
// This file reads the workflow text and pins the values themselves.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionYml = readFileSync(path.join(ROOT, 'action.yml'), 'utf8');

// The shape the sibling scanners use. It appears twice in action.yml: once
// in the comment that names the rule, and once as the SEMVER assignment the
// step actually matches. A third copy, or a quieter edit of either one, is
// the drift this count exists to catch.
const VERSION_SHAPE = String.raw`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`;
const VERSION_SHAPE_OCCURRENCES = 2;

describe('action.yml hardening drift check', () => {
  it('keeps the npm signature floor at 10.5.2', () => {
    expect(actionYml).toContain('npm 10.5.2 or newer');
    expect(actionYml).toContain('[ "$NPM_MAJOR" -gt 10 ]');
    expect(actionYml).toContain('[ "$NPM_MAJOR" -eq 10 ]');
    expect(actionYml).toContain('[ "$NPM_MINOR" -gt 5 ]');
    expect(actionYml).toContain('[ "$NPM_MINOR" -eq 5 ]');
    expect(actionYml).toContain('[ "$NPM_PATCH" -ge 2 ]');
  });

  it('keeps the version shape regex, and only at its current count', () => {
    const hits = actionYml.split(VERSION_SHAPE).length - 1;
    expect(hits).toBe(VERSION_SHAPE_OCCURRENCES);
    expect(actionYml).toContain(`SEMVER='${VERSION_SHAPE}'`);
  });

  it('puts the install on PATH before the signature audit, not after', () => {
    // Ordered the other way, a failing audit leaves the install unreachable
    // and the next step reports a missing binary rather than a refusal. That
    // is what the 2026-09-22 incident looked like from the outside. The PATH
    // write grants nothing on its own: the gates step does not run when the
    // install step fails.
    const executable = actionYml
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#'));
    const pathIndex = executable.findIndex((line) => line.includes('>> "$GITHUB_PATH"'));
    const auditIndex = executable.findIndex((line) => line.includes('npm audit signatures'));
    expect(pathIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(-1);
    expect(pathIndex).toBeLessThan(auditIndex);
  });

  it('installs with --ignore-scripts and then audits signatures', () => {
    expect(actionYml).toContain('npm install -g --ignore-scripts');
    // The phrase "npm audit signatures" also appears in comments. The pin is
    // the invocation inside the cd subshell, so a comment copy cannot keep
    // this green after the call itself is removed.
    expect(actionYml).toContain('( cd "$npm_config_prefix/lib" && npm audit signatures )');
  });
});
