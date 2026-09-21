import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GateOutcome } from '../src/gate-runner.js';
import { normalizeDepGuard, normalizeMissingGate, normalizeVaultGuard } from '../src/normalize.js';
import { renderText } from '../src/output-text.js';
import type { RunResult } from '../src/run.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function outcome(overrides: Partial<GateOutcome>): GateOutcome {
  return {
    role: 'dependencies',
    product: 'dep-guard',
    productVersion: '0.2.0',
    argv: ['scan', '--staged', '--format', 'json'],
    binary: {
      command: '/usr/local/bin/dep-guard',
      argvPrefix: ['scan'],
      source: 'path',
      candidate: 'dep-guard',
      versionProbe: null,
    },
    exitCode: 1,
    durationMs: 75,
    stage: 'commit',
    enforce: true,
    couldNotRun: null,
    findings: [],
    run: { failOn: 'medium', suppressed: 0, ignored: 0, diagnostics: [], details: {} },
    diagnostics: [],
    stderr: '',
    ...overrides,
  } as GateOutcome;
}

function result(
  gates: GateOutcome[],
  exitCode: number,
  deferred: RunResult['deferred'] = [],
  skipped: RunResult['skipped'] = [],
  excluded: RunResult['excluded'] = []
): RunResult {
  const findings = gates.flatMap((gate) => gate.findings);
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-02T00:00:00.000Z',
    gates,
    deferred,
    skipped,
    excluded,
    findings,
    trustBase: null,
    proposals: [],
    summary: {
      blocking: findings.filter((finding) => finding.blocking).length,
      byProduct: {},
      bySeverity: {},
    },
    exitCode,
  };
}

const depGuard = normalizeDepGuard(fixture('dep-guard-0.2.0-blocking.json'), '0.2.0');
const vaultGuard = normalizeVaultGuard(fixture('vault-guard-1.4.2-blocking.json'), '1.4.2');

describe('the combined text report', () => {
  const text = renderText(
    result(
      [
        outcome({ findings: depGuard.findings, run: depGuard.run }),
        outcome({
          role: 'secrets',
          product: 'vault-guard',
          productVersion: '1.4.2',
          findings: vaultGuard.findings,
          run: vaultGuard.run,
        }),
      ],
      1
    )
  );

  it('has one section per gate, in gate order', () => {
    const dependencies = text.indexOf('dependencies');
    const secrets = text.indexOf('secrets');
    expect(dependencies).toBeGreaterThan(-1);
    expect(secrets).toBeGreaterThan(dependencies);
  });

  it('names the product and its version in the section header', () => {
    expect(text).toMatch(/dep-guard 0\.2\.0/);
    expect(text).toMatch(/vault-guard 1\.4\.2/);
  });

  it('shows the exit code and duration each gate reported', () => {
    expect(text).toMatch(/exit 1/);
    expect(text).toMatch(/75ms/);
  });

  it('puts blocking findings before the rest', () => {
    const lines = text.split('\n').filter((line) => line.includes('dep-guard/'));
    // Both fixture findings block, and the critical one leads.
    expect(lines[0]).toMatch(/critical/);
    expect(lines[0]).toMatch(/typosquat/);
  });

  it('shows the threshold each gate gated on, rather than one shared number', () => {
    expect(text).toMatch(/threshold medium/);
  });

  it('reports the suppressed and ignored counts, so a quiet report is not mistaken for a clean one', () => {
    expect(text).toMatch(/suppressed 0/);
    expect(text).toMatch(/ignored 0/);
  });

  it('says "ignored not reported" for a gate that reports no ignore count', () => {
    // vault-guard drops ignored files before they reach its output, so it
    // has no count to give. Printing "ignored 0" states a fact the gate
    // never stated, and reads as "nothing was ignored".
    const secretsSection = text.slice(text.indexOf('secrets'));
    expect(secretsSection).toMatch(/ignored not reported/);
    expect(secretsSection).not.toMatch(/ignored 0/);
  });

  it('renders the per-gate run facts rather than collecting them and dropping them', () => {
    expect(text).toMatch(/mode staged/);
    expect(text).toMatch(/lockfileFormat none/);
    expect(text).toMatch(/patternsActive 59/);
  });

  it('leaves out a run fact the gate did not report', () => {
    // A null is an absence, not a value: "corpusBuiltAt null" is noise.
    expect(text).not.toMatch(/\bnull\b/);
  });

  it('leaves out a structured run fact rather than rendering it as [object Object]', () => {
    // Caught in a real dogfood run: the intent gate's category breakdown
    // printed as "[object Object]" and its empty reasons list printed as a
    // key with no value. Both belong in the SARIF details bag, not in a
    // one-line terminal summary.
    const structured = renderText(
      result(
        [
          outcome({
            role: 'intent',
            product: 'intent-guard',
            run: {
              failOn: null,
              suppressed: 0,
              ignored: 0,
              diagnostics: [],
              details: {
                contractFound: true,
                driftCategories: { scope_creep: 0 },
                reasons: [],
                driftAction: 'proceed',
              },
            },
          }),
        ],
        0
      )
    );

    expect(structured).not.toMatch(/\[object Object\]/);
    expect(structured).not.toMatch(/driftCategories/);
    expect(structured).not.toMatch(/reasons/);
    // The scalars beside them still render.
    expect(structured).toMatch(/contractFound true/);
    expect(structured).toMatch(/driftAction proceed/);
  });

  it('shows a gate diagnostic without turning it into a finding', () => {
    expect(text).toMatch(/lockfile-missing/);
    expect(text.match(/dep-guard\//g)).toHaveLength(2);
  });

  it('ends with a one-line verdict carrying the composed exit code', () => {
    const last = text.trimEnd().split('\n').pop() as string;
    expect(last).toMatch(/^verdict:/);
    expect(last).toMatch(/exit 1/);
  });
});

describe('the version line in the full report', () => {
  it('prints "conductor <version>" as the first line when a version is given', () => {
    const text = renderText(
      result([outcome({ exitCode: 1, findings: depGuard.findings, run: depGuard.run })], 1),
      { version: '9.9.9' }
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('conductor 9.9.9');
  });

  it('prints no version line at all when none is given', () => {
    const text = renderText(
      result([outcome({ exitCode: 1, findings: depGuard.findings, run: depGuard.run })], 1)
    );
    expect(text).not.toMatch(/^conductor \d/m);
  });

  it('does not add a line to the one-line clean summary', () => {
    // The summary line is kept to exactly one line by design; the version is
    // not the fact a clean run needs to lead with, so it stays off this path.
    const text = renderText(result([outcome({ exitCode: 0 })], 0), { version: '9.9.9' });
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('a gate that could not run', () => {
  const text = renderText(
    result(
      [
        outcome({
          role: 'intent',
          product: 'intent-guard',
          productVersion: null,
          exitCode: null,
          binary: null,
          couldNotRun: { reason: 'binary-missing', detail: 'no intent-guard binary on PATH' },
          findings: [normalizeMissingGate('intent', 'intent-guard', ['intent-guard'])],
        }),
      ],
      2
    )
  );

  it('says so loudly instead of printing an empty clean section', () => {
    expect(text).toMatch(/DID NOT RUN/);
    expect(text).toMatch(/binary-missing/);
  });

  it('prints the umbrella own blocking finding in that gate section', () => {
    expect(text).toMatch(/conductor\/gate-missing/);
  });

  it('says the version is unknown rather than printing a blank', () => {
    expect(text).toMatch(/version unknown/);
  });

  it('makes the verdict say a gate could not run, not that the code is clean', () => {
    const last = text.trimEnd().split('\n').pop() as string;
    expect(last).toMatch(/could not run/);
    expect(last).toMatch(/exit 2/);
  });
});

describe('a clean run', () => {
  it('says every gate ran and none blocked, under --verbose', () => {
    const text = renderText(result([outcome({ exitCode: 0 })], 0), { verbose: true });
    const last = text.trimEnd().split('\n').pop() as string;
    expect(last).toMatch(/exit 0/);
    expect(last).toMatch(/none blocked/);
  });
});

describe('a fully clean run, which is most runs', () => {
  // The whole v0.2 design constraint is that the gates must not slow
  // development down, and the cost it names is CEREMONY rather than runtime.
  // Twelve lines of per-gate detail on a commit that found nothing is that
  // cost being paid on every commit, so a clean run says one line.
  const clean = result(
    [
      outcome({ exitCode: 0 }),
      outcome({ role: 'secrets', product: 'vault-guard', productVersion: '1.4.2', exitCode: 0 }),
    ],
    0
  );

  it('prints exactly one line', () => {
    const text = renderText(clean);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });

  it('names the gates that ran', () => {
    const text = renderText(clean);
    expect(text).toMatch(/dependencies/);
    expect(text).toMatch(/secrets/);
  });

  it('prints none of the per-gate detail', () => {
    const text = renderText(clean);
    expect(text).not.toMatch(/threshold/);
    expect(text).toMatch(/0 suppressed, 0 ignored across all gates/);
    expect(text).not.toMatch(/^verdict:/m);
  });

  it('says how to see the detail', () => {
    expect(renderText(clean)).toMatch(/--verbose/);
  });

  it('prints the full report under --verbose', () => {
    const text = renderText(clean, { verbose: true });
    expect(text).toMatch(/threshold medium/);
    expect(text).toMatch(/^verdict: exit 0/m);
  });

  it('names a gate the stage filter deferred, on the same line', () => {
    // A deferred gate is the one thing a summary line must never swallow: a
    // commit-stage run otherwise reads exactly like a run that checked
    // everything.
    const text = renderText(
      result([outcome({ exitCode: 0 })], 0, [
        { role: 'intent', product: 'intent-guard', stage: 'ci' },
      ])
    );
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(text).toMatch(/Deferred to a later stage/);
    expect(text).toMatch(/intent/);
    expect(text).toMatch(/stage ci/);
  });

  it('counts the gate own notes rather than hiding them or printing them all', () => {
    // A gate's own note is a statement about how much this run covered: the
    // standing one about pnpm lockfiles not recording install-script
    // metadata is a permanent property of that file format rather than news
    // about this commit. Counted, not printed, and it does not stop the run
    // being clean.
    const text = renderText(
      result(
        [
          outcome({
            exitCode: 0,
            run: {
              failOn: 'medium',
              suppressed: 0,
              ignored: 0,
              diagnostics: [
                { code: 'dep-guard/lockfile-missing', message: 'no lockfile found' },
                { code: 'dep-guard/no-script-metadata', message: 'the format records none' },
              ],
              details: {},
            },
          }),
        ],
        0
      )
    );

    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(text).toMatch(/2 note\(s\)/);
    expect(text).not.toMatch(/lockfile-missing/);
  });

  it('names a gate that ran but could not have blocked anything', () => {
    // A repository on the adoption ramp otherwise reads clean with no hint
    // that one of the gates it just named had no vote. "Clean" and "one of
    // these could not have failed the run" are two different pieces of news.
    const text = renderText(
      result(
        [
          outcome({ exitCode: 0 }),
          outcome({ role: 'intent', product: 'intent-guard', exitCode: 0, enforce: false }),
        ],
        0
      )
    );

    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(text).toMatch(/enforce: false in \.guardrails\.yaml: intent \(intent-guard\)/);
    // The gate that did have a vote is not swept into the same clause.
    expect(text).not.toMatch(/enforce: false[^.]*dependencies/);
  });

  it('says every gate that ran was enforced, as a zero count that still prints', () => {
    expect(renderText(result([outcome({ exitCode: 0 })], 0))).toMatch(/0 gate\(s\) not enforced/);
  });
});

describe('an umbrella diagnostic is not a note', () => {
  // The discriminator, applied: a statement about how much of the policy a
  // run covered is a notification, and a statement that something went wrong
  // is a result. A gate's own note is the first.
  // conductor/blocking-count-mismatch is the second: it is the umbrella saying
  // its own report may disagree with the gate's own verdict, which is a defect
  // in this run rather than a permanent property of anything.
  const withDiagnostic = result(
    [
      outcome({
        exitCode: 0,
        diagnostics: [
          { code: 'conductor/blocking-count-mismatch', message: 'the counts disagree' },
        ],
      }),
    ],
    0
  );

  it('prints the full report even though nothing blocked and nothing broke', () => {
    const text = renderText(withDiagnostic);

    expect(text).toMatch(/^conductor run: /m);
    expect(text).toMatch(/blocking-count-mismatch/);
    expect(text).toMatch(/^verdict: exit 0/m);
  });

  it('is not counted among the notes on a summary line, because there is none', () => {
    expect(renderText(withDiagnostic)).not.toMatch(/note\(s\)/);
  });
});

describe('a run that is not fully clean prints the full report', () => {
  it('prints it when a gate blocked', () => {
    const text = renderText(result([outcome({ exitCode: 1, findings: depGuard.findings, run: depGuard.run })], 1));
    expect(text).toMatch(/^conductor run: /m);
    expect(text).toMatch(/^verdict: exit 1/m);
  });

  it('prints it when an unenforced gate blocked, even though the run exits 0', () => {
    // The exit code alone is not the test. A gate with enforce: false that
    // blocked found something real, and a one-line "clean" would swallow the
    // only report of it anybody sees.
    const text = renderText(
      result([outcome({ exitCode: 1, enforce: false, findings: depGuard.findings, run: depGuard.run })], 0)
    );
    expect(text).toMatch(/BLOCKING/);
    expect(text).toMatch(/dep-guard\/typosquat/);
    expect(text).toMatch(/^verdict: exit 0/m);
  });

  it('prints it when a gate could not run, even though the run exits 0', () => {
    const text = renderText(
      result(
        [
          outcome({
            role: 'intent',
            product: 'intent-guard',
            productVersion: null,
            exitCode: null,
            binary: null,
            enforce: false,
            couldNotRun: { reason: 'binary-missing', detail: 'no intent-guard binary on PATH' },
            findings: [normalizeMissingGate('intent', 'intent-guard', ['intent-guard'])],
          }),
        ],
        0
      )
    );
    expect(text).toMatch(/DID NOT RUN/);
  });

  it('prints it when no gate ran at all, so the three empty-run verdicts survive', () => {
    // Nothing blocked and nothing broke, so the clean predicate holds, but
    // "no gate ran because none is enabled" is exactly the state somebody
    // needs told about and it is not a clean commit.
    const text = renderText(result([], 0));
    expect(text).toMatch(/no gate ran/);
  });
});

describe('a gate that blocked but is not enforced', () => {
  const text = renderText(
    result(
      [
        outcome({
          exitCode: 1,
          enforce: false,
          findings: depGuard.findings,
          run: depGuard.run,
        }),
      ],
      0
    )
  );

  it('still prints every finding, with the gate own blocking marker intact', () => {
    // enforce: false is about the exit code and nothing else. Quieting the
    // findings would make the report agree with the exit code by hiding what
    // the gate actually said.
    expect(text).toMatch(/BLOCKING/);
    expect(text).toMatch(/dep-guard\/typosquat/);
  });

  it('says in plain words that the gate blocked and enforce is false', () => {
    // A green exit next to red findings has to explain itself on the same
    // screen, or the next reader assumes the report is broken.
    expect(text).toMatch(/enforce/);
    expect(text).toMatch(/not enforced/);
  });

  it('marks the gate header, so the section is not read as an ordinary failure', () => {
    const header = text.split('\n').find((line) => line.startsWith('dependencies')) as string;
    expect(header).toMatch(/not enforced/);
  });

  it('does not claim in the verdict that none blocked', () => {
    const last = text.trimEnd().split('\n').pop() as string;
    expect(last).toMatch(/exit 0/);
    expect(last).not.toMatch(/none blocked/);
    expect(last).toMatch(/enforce/);
  });
});

describe('a gate that could not run and is not enforced', () => {
  const text = renderText(
    result(
      [
        outcome({
          role: 'intent',
          product: 'intent-guard',
          productVersion: null,
          exitCode: null,
          binary: null,
          enforce: false,
          couldNotRun: { reason: 'binary-missing', detail: 'no intent-guard binary on PATH' },
          findings: [normalizeMissingGate('intent', 'intent-guard', ['intent-guard'])],
        }),
      ],
      0
    )
  );

  it('still says loudly that the gate did not run', () => {
    expect(text).toMatch(/DID NOT RUN/);
    expect(text).toMatch(/binary-missing/);
  });

  it('records it as a note rather than as the exit 2 it would otherwise be', () => {
    expect(text).toMatch(/not enforced/);
    const last = text.trimEnd().split('\n').pop() as string;
    expect(last).toMatch(/exit 0/);
    expect(last).not.toMatch(/^verdict: exit 2/);
  });

  it('does not also call it a gate that blocked', () => {
    // Its findings list holds the umbrella's own blocking gate-missing
    // finding, so a naive "has a blocking finding" test reports the same
    // gate as having blocked AND as having failed to run, which are
    // opposite claims about the same gate.
    const last = text.trimEnd().split('\n').pop() as string;
    expect(last).toMatch(/intent could not run/);
    expect(last).not.toMatch(/intent blocked/);
  });
});

describe('the verdict when enforced and unenforced gates are mixed', () => {
  function brokenGate(role: 'secrets' | 'intent', enforce: boolean) {
    return outcome({
      role,
      product: role === 'secrets' ? 'vault-guard' : 'intent-guard',
      productVersion: null,
      exitCode: null,
      binary: null,
      enforce,
      couldNotRun: { reason: 'binary-missing', detail: 'binary missing' },
      findings: [
        normalizeMissingGate(
          role,
          role === 'secrets' ? 'vault-guard' : 'intent-guard',
          [role === 'secrets' ? 'vault-guard' : 'intent-guard']
        ),
      ],
    });
  }

  it('names only the enforced gate as the reason for exit 2', () => {
    // The unenforced one could not run either, but it is not why this run
    // failed, and listing it among the reasons sends somebody to install a
    // gate that would not have changed the answer.
    const text = renderText(result([brokenGate('secrets', true), brokenGate('intent', false)], 2));
    const last = text.trimEnd().split('\n').pop() as string;

    expect(last).toMatch(/exit 2/);
    // The parenthesised list is the reason. Exactly one gate is in it.
    expect(last).toMatch(/a gate could not run \(secrets\)/);
    expect(last).not.toMatch(/\([^)]*intent[^)]*\)/);
  });

  it('still mentions the unenforced gate, as something that is not the reason', () => {
    const text = renderText(result([brokenGate('secrets', true), brokenGate('intent', false)], 2));
    const last = text.trimEnd().split('\n').pop() as string;

    expect(last).toMatch(/intent could not run/);
    expect(last).toMatch(/that is not why/);
  });

  it('counts only enforced gates in the exit 1 verdict', () => {
    // One enforced gate blocked. The unenforced one contributed a finding of
    // the umbrella's own, and counting it made the verdict claim two
    // blocking findings across two gates for a run that failed over one.
    const text = renderText(
      result(
        [
          outcome({ exitCode: 1, findings: depGuard.findings, run: depGuard.run }),
          brokenGate('intent', false),
        ],
        1
      )
    );
    const last = text.trimEnd().split('\n').pop() as string;

    expect(last).toMatch(/exit 1/);
    expect(last).toMatch(/2 blocking finding\(s\) across 1 gate\(s\)/);
    expect(last).not.toMatch(/across 2 gate\(s\)/);
  });

  it('lets the header count everything on screen while the verdict counts what failed', () => {
    // Two different questions. The header is an inventory of the report
    // under it, so a reader counting finding lines has to reach its number;
    // the verdict is about what failed the run. Narrowing the header would
    // make it disagree with the lines it introduces.
    const text = renderText(
      result(
        [
          outcome({ exitCode: 1, findings: depGuard.findings, run: depGuard.run }),
          brokenGate('intent', false),
        ],
        1
      )
    );

    expect(text).toMatch(/^conductor run: 2 gate\(s\), 3 finding\(s\)/m);
    expect(text).toMatch(/verdict: exit 1, 2 blocking finding\(s\) across 1 gate\(s\)/);
  });

  it('still says the unenforced gate broke, in the same exit 1 verdict', () => {
    // Dropping it from the count must not drop it from the sentence: a gate
    // that verified nothing is worth a line whatever the exit code was.
    const text = renderText(
      result(
        [
          outcome({ exitCode: 1, findings: depGuard.findings, run: depGuard.run }),
          brokenGate('intent', false),
        ],
        1
      )
    );
    const last = text.trimEnd().split('\n').pop() as string;

    expect(last).toMatch(/intent could not run/);
    expect(last).toMatch(/enforce: false/);
  });
});

describe('the verdict when the run exits 1 and nothing is marked blocking', () => {
  // Both branches of reconcileBlocking drop every blocking flag to false while
  // the gate's own non-zero exit code stands, so composeExitCode still returns
  // 1. The verdict is the one line somebody reads when they read nothing else,
  // and "exit 1, 0 blocking finding(s)" contradicts itself on that line.
  function depGuardRaw(): { run: Record<string, unknown> } {
    return fixture('dep-guard-0.2.0-blocking.json') as { run: Record<string, unknown> };
  }

  function verdictFor(raw: unknown): string {
    const normalized = normalizeDepGuard(raw, '0.2.0');
    // The precondition this whole branch is about: the gate exited non-zero
    // and the umbrella marked nothing blocking.
    expect(normalized.findings.some((finding) => finding.blocking)).toBe(false);
    expect(normalized.diagnostics).toHaveLength(1);
    const text = renderText(
      result(
        [outcome({ exitCode: 1, findings: normalized.findings, run: normalized.run, diagnostics: normalized.diagnostics })],
        1
      )
    );
    return text.trimEnd().split('\n').pop() as string;
  }

  it('does not print a blocking count when the threshold was never reported', () => {
    const raw = depGuardRaw();
    delete raw.run.failOn;
    const last = verdictFor(raw);

    expect(last).toMatch(/exit 1/);
    expect(last).not.toMatch(/0 blocking finding\(s\)/);
    expect(last).toMatch(/dependencies/);
    expect(last).toMatch(/could not reconcile/);
    expect(last).toMatch(/exit code decided the run/);
  });

  it('does not print a blocking count when the gate own count and the umbrella count disagree', () => {
    const raw = depGuardRaw();
    raw.run.blockingMatches = 5;
    const last = verdictFor(raw);

    expect(last).toMatch(/exit 1/);
    expect(last).not.toMatch(/0 blocking finding\(s\)/);
    expect(last).toMatch(/dependencies/);
    expect(last).toMatch(/could not reconcile/);
    expect(last).toMatch(/exit code decided the run/);
  });

  it('keeps the unenforced aside on that verdict', () => {
    const raw = depGuardRaw();
    delete raw.run.failOn;
    const normalized = normalizeDepGuard(raw, '0.2.0');
    const text = renderText(
      result(
        [
          outcome({
            exitCode: 1,
            findings: normalized.findings,
            run: normalized.run,
            diagnostics: normalized.diagnostics,
          }),
          outcome({
            role: 'intent',
            product: 'intent-guard',
            productVersion: null,
            exitCode: null,
            binary: null,
            enforce: false,
            couldNotRun: { reason: 'binary-missing', detail: 'binary missing' },
            findings: [normalizeMissingGate('intent', 'intent-guard', ['intent-guard'])],
          }),
        ],
        1
      )
    );
    const last = text.trimEnd().split('\n').pop() as string;

    expect(last).toMatch(/intent could not run/);
    expect(last).toMatch(/that is not why/);
  });
});

describe('a gate the stage filter deferred', () => {
  // Verbose, because the run below is otherwise fully clean and would print
  // the one-line summary. The summary line's own deferred clause is covered
  // in the fully-clean block above.
  const text = renderText(
    result([outcome({ exitCode: 0 })], 0, [
      { role: 'intent', product: 'intent-guard', stage: 'ci' },
    ]),
    { verbose: true }
  );

  it('says the gate was deferred and names the stage it is waiting for', () => {
    // A gate that is switched on and did not run has to be on screen, or a
    // commit-stage run reads exactly like a run that checked everything.
    expect(text).toMatch(/deferred/);
    expect(text).toMatch(/intent/);
    expect(text).toMatch(/stage ci/);
  });

  it('does not dress it up as a gate that could not run', () => {
    // Could-not-run is exit 2 and a failure. Deferred is neither.
    expect(text).not.toMatch(/DID NOT RUN/);
  });

  it('counts only the gates that actually ran in the header', () => {
    expect(text).toMatch(/^conductor run: 1 gate\(s\)/m);
  });
});

describe('a run restricted with --gate', () => {
  const excluded: RunResult['excluded'] = [
    { role: 'secrets', product: 'vault-guard' },
    { role: 'intent', product: 'intent-guard' },
  ];

  it('names the excluded gates in the full report', () => {
    // The same reason a deferred gate gets a line: a run that checked one
    // role otherwise reads exactly like a run that checked the policy.
    const text = renderText(result([outcome({ exitCode: 0 })], 0, [], [], excluded), {
      verbose: true,
    });

    expect(text).toMatch(/excluded/);
    expect(text).toMatch(/secrets/);
    expect(text).toMatch(/intent/);
    expect(text).toMatch(/--gate/);
  });

  it('names them on the one-line summary of a clean run too', () => {
    const text = renderText(result([outcome({ exitCode: 0 })], 0, [], [], excluded));

    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(text).toMatch(/--gate/);
    expect(text).toMatch(/secrets \(vault-guard\)/);
    expect(text).toMatch(/intent \(intent-guard\)/);
  });

  it('reports exclusion as a zero count on the summary, and the full report stays silent', () => {
    expect(renderText(result([outcome({ exitCode: 0 })], 0))).toMatch(/0 gate\(s\) left out by --gate/);
    expect(
      renderText(result([outcome({ exitCode: 0 })], 0), { verbose: true })
    ).not.toMatch(/excluded|--gate/);
  });
});

describe('a run where every enabled gate was deferred', () => {
  const text = renderText(
    result([], 0, [
      { role: 'intent', product: 'intent-guard', stage: 'ci' },
    ])
  );

  it('says so rather than claiming nothing is enabled', () => {
    // The two states look identical in a report and are not the same
    // problem: one is a policy file with everything switched off, the other
    // is a stage that had nothing to do.
    const last = text.trimEnd().split('\n').pop() as string;
    expect(last).toMatch(/exit 0/);
    expect(last).toMatch(/deferred/);
    expect(last).not.toMatch(/none is enabled/);
  });
});

describe('a run with no enabled gates', () => {
  const text = renderText(result([], 0));

  it('says no gate ran rather than reporting a clean pass', () => {
    // Exit 0 with an empty report is indistinguishable from a clean run at a
    // glance, and a policy file with every gate switched off is exactly the
    // state somebody needs told about.
    const last = text.trimEnd().split('\n').pop() as string;
    expect(last).toMatch(/no gate ran/);
    expect(last).not.toMatch(/none blocked/);
  });

  it('still exits 0, because nothing was asked for and nothing failed', () => {
    expect(result([], 0).exitCode).toBe(0);
  });

  it('says where to turn one on', () => {
    expect(text).toMatch(/\.guardrails\.yaml/);
  });
});

// The family suppression rule, on the umbrella's one-line summary: a gate that
// can be turned off, or one the command line dropped, or a baselined finding
// count, is the user's decision, and a clean line that says nothing about it
// lets a repository read as fully gated when a gate's result did not move the
// exit code. Each of these prints even at zero.
describe('the clean summary makes suppression visible', () => {
  const runWith = (gates: Parameters<typeof result>[0], excluded: RunResult['excluded'] = []) =>
    renderText(result(gates, 0, [], [], excluded));

  const cleanRun = { failOn: 'medium', suppressed: 0, ignored: 0, diagnostics: [], details: {} };

  it('prints the not-enforced count even when it is zero', () => {
    expect(runWith([outcome({ exitCode: 0 })])).toMatch(/0 gate\(s\) not enforced/);
  });

  it('counts and names the gates that are not enforced', () => {
    const text = runWith([
      outcome({ exitCode: 0 }),
      outcome({ role: 'intent', product: 'intent-guard', exitCode: 0, enforce: false }),
    ]);
    expect(text).toMatch(/1 gate\(s\) not enforced/);
    expect(text).toMatch(/intent \(intent-guard\)/);
  });

  it('prints the excluded count even when it is zero', () => {
    expect(runWith([outcome({ exitCode: 0 })])).toMatch(/0 gate\(s\) left out by --gate/);
  });

  it('counts and names the gates the command line left out', () => {
    const text = runWith([outcome({ exitCode: 0 })], [{ role: 'secrets', product: 'vault-guard' }]);
    expect(text).toMatch(/1 gate\(s\) left out by --gate/);
    expect(text).toMatch(/secrets \(vault-guard\)/);
  });

  it('sums the suppressed and ignored counts across gates, even at zero', () => {
    expect(runWith([outcome({ exitCode: 0 })])).toMatch(/0 suppressed, 0 ignored across all gates/);
  });

  it('adds the suppressed and ignored counts the gates reported', () => {
    const text = runWith([
      outcome({ exitCode: 0, run: { ...cleanRun, suppressed: 3, ignored: 1 } }),
      outcome({
        role: 'secrets',
        product: 'vault-guard',
        exitCode: 0,
        run: { ...cleanRun, suppressed: 5, ignored: 2 },
      }),
    ]);
    expect(text).toMatch(/8 suppressed, 3 ignored across all gates/);
  });

  it('drops the ignored total when a gate that ran reported no ignore count', () => {
    // vault-guard drops ignored files before its own output, so "0 ignored"
    // across all gates would state a fact no gate stated. Suppressed still
    // shows, because that is always a number the gate reported.
    const text = runWith([
      outcome({ exitCode: 0, run: { ...cleanRun, suppressed: 2 } }),
      outcome({
        role: 'secrets',
        product: 'vault-guard',
        exitCode: 0,
        run: { ...cleanRun, suppressed: 4, details: { ignoredReported: false } },
      }),
    ]);
    expect(text).toMatch(/6 suppressed across all gates/);
    expect(text).not.toMatch(/ignored/);
    // Still one line.
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });
});

/**
 * Pull-request mode in the text report.
 *
 * The clean one-line summary is the half that matters most, and it is easy to
 * get wrong by leaving it to the full report: a pull request that proposes to
 * switch a gate off and carries nothing else produces a CLEAN run, so the
 * one line a hook and a pull request comment print is the only place the
 * attempt is ever seen.
 */
describe('pull-request mode in the text report', () => {
  const cleanIntent = {
    failOn: null,
    suppressed: 0,
    ignored: 0,
    diagnostics: [],
    details: {},
  };

  function pullRequest(overrides: Partial<RunResult>): RunResult {
    return {
      ...result([outcome({ exitCode: 0, run: { ...cleanIntent, failOn: 'medium' } })], 0),
      trustBase: { ref: 'origin/main', policyChanged: false, refusal: null },
      proposals: [],
      ...overrides,
    };
  }

  it('counts the proposals on the one line a clean run prints, even at zero', () => {
    const text = renderText(pullRequest({}));

    expect(text).toMatch(/Rules from origin\/main\./);
    expect(text).toMatch(/0 control change\(s\) proposed in this pull request\./);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });

  it('says nothing about any of it outside pull-request mode', () => {
    const text = renderText(
      result([outcome({ exitCode: 0, run: { ...cleanIntent, failOn: 'medium' } })], 0)
    );

    expect(text).not.toMatch(/control change/);
    expect(text).not.toMatch(/Rules from/);
  });

  it('counts a policy change and a gate change together on the summary line', () => {
    const text = renderText(
      pullRequest({
        proposals: [
          { product: 'conductor', role: null, line: 'policy changed in this pull request' },
          {
            product: 'intent-guard',
            role: 'intent',
            line: 'contract changed in this pull request',
          },
        ],
        trustBase: { ref: 'origin/main', policyChanged: true, refusal: null },
      })
    );

    expect(text).toMatch(/2 control change\(s\) proposed in this pull request\./);
  });

  it('prints one line per proposal in the full report, the policy line first', () => {
    const text = renderText(
      pullRequest({
        proposals: [
          { product: 'conductor', role: null, line: 'policy changed in this pull request' },
          {
            product: 'intent-guard',
            role: 'intent',
            line: 'contract changed in this pull request',
          },
        ],
        trustBase: { ref: 'origin/main', policyChanged: true, refusal: null },
      }),
      { verbose: true }
    );

    const lines = text.split('\n').filter((line) => line.trim().startsWith('proposed'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/conductor\s+policy changed in this pull request/);
    expect(lines[1]).toMatch(/intent-guard\s+contract changed in this pull request/);
    expect(text).toMatch(/pull-request mode: rules from origin\/main/);
  });

  it('names a gate that was NOT put into pull-request mode, on the clean line too', () => {
    // The loudest fact this report can carry: that gate read its own control
    // inputs out of the tree being judged. A clean run must not hide it.
    const text = renderText(
      pullRequest({
        gates: [
          outcome({
            role: 'intent',
            product: 'intent-guard',
            productVersion: '1.3.1',
            exitCode: 0,
            run: { ...cleanIntent, failOn: 'medium' },
            trustBase: {
              ref: 'origin/main',
              withheld: 'intent-guard 1.3.1 does not understand --trust-base.',
              refused: null,
              proposals: [],
            },
          }),
        ],
      })
    );

    expect(text).toMatch(/1 gate\(s\) NOT in pull-request mode: intent \(intent-guard\)\./);
  });

  it('says why in the full report, in the gate own words', () => {
    const text = renderText(
      pullRequest({
        gates: [
          outcome({
            role: 'intent',
            product: 'intent-guard',
            productVersion: '1.3.1',
            exitCode: 0,
            run: { ...cleanIntent, failOn: 'medium' },
            trustBase: {
              ref: 'origin/main',
              withheld: 'intent-guard 1.3.1 does not understand --trust-base.',
              refused: null,
              proposals: [],
            },
          }),
        ],
      }),
      { verbose: true }
    );

    expect(text).toMatch(
      /NOT in pull-request mode\s+intent\s+intent-guard\s+intent-guard 1\.3\.1 does not understand/
    );
  });
});

/**
 * A refused trust base renders as a refusal, whatever the inventory holds.
 *
 * The gap this closes was reachable on the DEFAULT actions/checkout, which
 * fetches depth 1 and so carries no base ref. With an inventory that names no
 * gate -- every gate `enabled: false` in the head's file, or a head file that
 * will not parse at all, which leaves the inventory empty -- the verdict
 * short-circuited on `gates.length === 0` and printed "verdict: exit 0, no
 * gate ran because none is enabled", with the refusal sentence nowhere on
 * screen. The process still exited 2, so the build failed with a report
 * telling the reader to go and switch a gate on.
 *
 * A refusal is therefore its own outcome and renders FIRST, before any
 * question about how many gates there are.
 */
describe('a refused trust base in the text report', () => {
  const REFUSAL =
    'cannot read the policy from base ref "origin/main": it does not resolve to a commit in ' +
    'this repository. Nothing was checked. In CI, fetch the base branch (actions/checkout ' +
    'with fetch-depth: 0) before running the gates.';

  function refused(gates: GateOutcome[] = []): RunResult {
    return {
      ...result(gates, 2),
      trustBase: { ref: 'origin/main', policyChanged: false, refusal: REFUSAL },
      proposals: [],
    };
  }

  it('says exit 2 and the reason when the inventory names no gate at all', () => {
    const text = renderText(refused());

    expect(text).toMatch(/verdict: exit 2/);
    expect(text).toMatch(/does not resolve to a commit/);
    expect(text).not.toMatch(/verdict: exit 0/);
    expect(text).not.toMatch(/Set enabled: true/);
  });

  it('carries the fetch-depth remedy, which is the fix in nine cases out of ten', () => {
    expect(renderText(refused())).toMatch(/fetch-depth: 0/);
  });

  it('leads with the refusal rather than burying it under the gate sections', () => {
    const lines = renderText(
      refused([outcome({ role: 'secrets', product: 'vault-guard', exitCode: null })])
    ).split('\n');

    expect(lines[0]).toMatch(/refused the trust base/);
    expect(lines[0]).toMatch(/origin\/main/);
  });

  it('still names the gates the inventory did hold', () => {
    const text = renderText(
      refused([
        outcome({
          role: 'secrets',
          product: 'vault-guard',
          exitCode: null,
          couldNotRun: { reason: 'preparation-failed', detail: REFUSAL },
        }),
      ])
    );

    expect(text).toMatch(/secrets\s+vault-guard/);
    expect(text).toMatch(/DID NOT RUN/);
  });

  it('never prints the clean one-line summary for a refusal', () => {
    // The summary path is reached on exitCode 0 with every gate clean, and an
    // empty-inventory refusal has no gate to be unclean. Belt and braces.
    const text = renderText({ ...refused(), exitCode: 0 });

    expect(text).not.toMatch(/conductor: clean, nothing blocked/);
    expect(text).toMatch(/refused the trust base/);
  });

  describe('compact mode', () => {
    // The pull-request-comment step runs --verbose so a real finding gets the
    // full report; an adopter with no policy on the base ref at all gets a
    // full sticky comment every push whose entire content is "refused,
    // nothing checked". Compact mode is the short form of exactly that case:
    // the version, the verdict sentence, and every refusal detail line the
    // full report would have printed for this case (the reason and, when
    // the base ref carries no policy file at all, the remedy it names).
    // There is no pointer at a step log: the reason is ON the comment
    // instead of behind a link to a log a fork's read-only token cannot
    // even show the commenter.
    it('prints the version, the verdict, and the full refusal reason', () => {
      const text = renderText(refused(), { compact: true, version: '9.9.9' });
      const lines = text.trimEnd().split('\n');

      expect(lines).toEqual([
        'conductor 9.9.9',
        'verdict: exit 2, the trust base "origin/main" could not be used, so no gate ran and ' +
          'nothing here is a result of any kind.',
        'conductor: refused the trust base "origin/main". Nothing was checked.',
        `  ${REFUSAL}`,
      ]);
      expect(text).not.toMatch(/step log/i);
    });

    it('omits the version line when none is given, but keeps the verdict and the reason', () => {
      const text = renderText(refused(), { compact: true });
      const lines = text.trimEnd().split('\n');

      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^verdict: exit 2/);
      expect(lines[1]).toMatch(/refused the trust base/);
      expect(lines[2]).toMatch(/does not resolve to a commit/);
      expect(text).not.toMatch(/step log/i);
    });

    it('wins over --verbose: a refusal never grows back to the full report under compact', () => {
      const text = renderText(refused(), { compact: true, verbose: true });
      expect(text.trimEnd().split('\n')).toHaveLength(3);
    });

    it('does nothing to a run that was not refused, even when requested', () => {
      const clean = result([outcome({ exitCode: 0 })], 0);
      const verboseText = renderText(clean, { compact: true, verbose: true });
      expect(verboseText).toMatch(/^conductor run: /m);

      const summaryText = renderText(clean, { compact: true });
      expect(summaryText.trimEnd().split('\n')).toHaveLength(1);
    });
  });
});

/**
 * The skipped node_modules candidate, in the full report.
 *
 * An adopter who installs the gates as devDependencies and nothing else sees
 * their gate resolve from somewhere they did not expect, or not resolve at
 * all. Without this line the only explanation is in a document. It goes in the
 * pull-request block because that is the only mode it can happen in.
 */
describe('the node_modules candidate a pull-request run skipped', () => {
  function skippedRun(gates: GateOutcome[]): RunResult {
    return {
      ...result(gates, 0),
      trustBase: { ref: 'origin/main', policyChanged: false, refusal: null },
    };
  }

  const skippedGate = outcome({
    exitCode: 0,
    nodeModulesSkipped: 'node_modules/.bin/dep-guard',
  } as Partial<GateOutcome>);

  it('names the gate and the path it declined to take', () => {
    const text = renderText(skippedRun([skippedGate]), { verbose: true });

    expect(text).toMatch(/node_modules\/\.bin not consulted/);
    expect(text).toMatch(/dependencies \(dep-guard\) at node_modules\/\.bin\/dep-guard/);
  });

  it('is one line for the whole run, however many gates were skipped', () => {
    const text = renderText(
      skippedRun([
        skippedGate,
        outcome({
          role: 'secrets',
          product: 'vault-guard',
          exitCode: 0,
          nodeModulesSkipped: 'node_modules/.bin/vault-guard',
        } as Partial<GateOutcome>),
      ]),
      { verbose: true }
    );

    const lines = text.split('\n').filter((line) => line.includes('node_modules/.bin not consulted'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/dependencies \(dep-guard\)/);
    expect(lines[0]).toMatch(/secrets \(vault-guard\)/);
  });

  it('says nothing when no candidate was there to skip', () => {
    const text = renderText(skippedRun([outcome({ exitCode: 0 })]), { verbose: true });

    expect(text).not.toMatch(/node_modules/);
  });
});
