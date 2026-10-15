import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliReadinessFactsFor } from '#testing/helpers/factories/detection.js';
import { buildReadinessReport } from './checks/build.js';
import {
  createStartReadinessRecord,
  formatReadinessReport,
  formatReadinessBlockers,
  readinessBlockerMessage,
  readinessBlockerPointer,
  serializeReadinessCheckJson,
} from './format.js';
import { deriveCliReadiness } from '../schemas/readiness.js';

describe('readiness formatting', () => {
  it('gives a concrete installation action for an untrusted executable', () => {
    expect(
      serializeReadinessCheckJson({
        id: 'runners.planner.admission',
        severity: 'blocker',
        summary: 'The CLI executable is not trusted.',
        diagnosticState: 'untrusted-path',
      }).remediation,
    ).toBe(
      'Install the configured CLI outside the project. Put its absolute directory first on PATH, then run `splitbrief doctor` again.',
    );
  });
  it('publishes every seat a shared CLI problem stops', () => {
    expect(
      serializeReadinessCheckJson({
        id: 'runners.preparation.planner',
        severity: 'blocker',
        summary: 'PLAN and REVIEW cannot start with OpenAI Codex CLI.',
        runnerCause: { tool: 'codex', cause: 'missing-binary', seats: ['PLAN', 'REVIEW'] },
      }).seats,
    ).toEqual(['PLAN', 'REVIEW']);
  });
  it('uses singular counts for one blocker and one warning', () => {
    const report = buildReadinessReport({
      projectDir: '/tmp/project',
      configLoad: { state: 'missing', path: '/tmp/project/.splitbrief/config.yaml', warnings: [] },
      packageScripts: { packageJsonExists: true, scripts: { test: 'node --test' } },
      repo: { isGitRepo: true, hasCommits: true, dirtyFiles: ['src/edit.ts'], untrackedFiles: [] },
    });
    expect(formatReadinessReport(report)).toContain('(1 blocker, 1 warning)');
    expect(formatReadinessBlockers(report)).toContain('blocked (1 blocker)');
  });
  it('states the fix of a blocker once', () => {
    const report = buildReadinessReport({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
      configLoad: { state: 'loaded', path: '/tmp/project/.splitbrief/config.yaml', warnings: [] },
      packageScripts: { packageJsonExists: true, scripts: { test: 'node --test' } },
      repo: { isGitRepo: true, hasCommits: false, dirtyFiles: [], untrackedFiles: [] },
      cliReadiness: [deriveCliReadiness(cliReadinessFactsFor('ready', 'claude-code'))],
    });
    for (const output of [formatReadinessReport(report), formatReadinessBlockers(report)]) {
      expect(output.match(/Make an initial commit/g)).toHaveLength(1);
    }
  });
  const blockedReport = () =>
    buildReadinessReport({
      projectDir: '/tmp/project',
      configLoad: {
        state: 'invalid',
        path: '/tmp/project/.splitbrief/config.yaml',
        warnings: [],
        error: 'bad config',
      },
      packageScripts: { packageJsonExists: false, scripts: {} },
      repo: { isGitRepo: false, hasCommits: false, dirtyFiles: [], untrackedFiles: [] },
    });

  it('formats fail-closed human output and compact start records without config secrets', () => {
    const report = buildReadinessReport({
      projectDir: '/tmp/project',
      config: makeConfig({
        validation: { endChecks: false },
      }),
      configLoad: {
        state: 'loaded',
        path: '/tmp/project/.splitbrief/config.yaml',
        warnings: [],
      },
      packageScripts: {
        packageJsonExists: true,
        scripts: { test: 'vitest run' },
      },
      repo: {
        isGitRepo: true,
        hasCommits: true,
        dirtyFiles: [],
        untrackedFiles: [],
      },
    });

    const human = formatReadinessReport(report);
    const record = createStartReadinessRecord(report);

    expect(human).toContain('Run readiness:');
    expect(human).not.toContain('Required action');
    expect(human.split('Run `splitbrief doctor` again to check Claude Code CLI.')).toHaveLength(2);
    expect(human).not.toContain('Advisory:');
    expect(human).not.toContain('Next action:');
    expect(human).not.toContain('runners.cli.claude-code.readiness');
    expect(human).not.toContain('validation.end-checks-off');
    expect(human).not.toContain('apiKey');
    expect(record).toMatchObject({
      type: 'start-readiness',
      status: 'blocked',
      nextAction: 'prepare-runner',
      blockerCount: 1,
      warningCount: expect.any(Number),
    });
    expect(record.checks.some((check) => check.id === 'runners.cli.claude-code.readiness')).toBe(
      true,
    );
    expect(record.checks.some((check) => check.id === 'validation.end-checks-off')).toBe(true);
  });

  it('does not publish trusted executable paths in human or JSON diagnostics', () => {
    const executablePath = '/Users/private-user/project/bin/claude';
    const report = buildReadinessReport({
      projectDir: '/tmp/readiness-project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
      configLoad: {
        state: 'loaded',
        path: '/tmp/readiness-project/.splitbrief/config.yaml',
        warnings: [],
      },
      packageScripts: {
        packageJsonExists: true,
        scripts: { test: 'vitest run' },
      },
      repo: {
        isGitRepo: true,
        hasCommits: true,
        dirtyFiles: [],
        untrackedFiles: [],
      },
      cliReadiness: [
        deriveCliReadiness({
          tool: 'claude-code',
          enabled: true,
          installation: 'installed',
          executable: {
            path: executablePath,
            fingerprint: { dev: 9, ino: 10, size: 11, mtimeMs: 12 },
          },
          trust: 'trusted',
          installedVersion: '2.0.0',
          testedVersion: '2.0.0',
          compatibility: 'compatible',
          auth: 'authenticated',
          probedAt: 1,
        }),
      ],
    });

    const human = formatReadinessReport(report);
    const json = JSON.stringify({ type: 'readiness_report', report });

    expect(human).not.toContain(executablePath);
    expect(json).not.toContain(executablePath);
    expect(json).toContain('[redacted executable path]');
  });

  it('promises start can continue only when every configured CLI runner is gated', () => {
    const reportWith = (state: 'ready' | 'unverified') =>
      buildReadinessReport({
        projectDir: '/tmp/project',
        config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
        configLoad: {
          state: 'loaded',
          path: '/tmp/project/.splitbrief/config.yaml',
          warnings: [],
        },
        packageScripts: { packageJsonExists: true, scripts: { test: 'vitest run' } },
        repo: {
          isGitRepo: true,
          hasCommits: true,
          dirtyFiles: ['src/edited.ts'],
          untrackedFiles: [],
        },
        cliReadiness: [deriveCliReadiness(cliReadinessFactsFor(state, 'claude-code'))],
      });

    const gated = formatReadinessReport(reportWith('ready'));
    expect(gated).toContain('Run readiness: ready with warnings (0 blockers, 1 warning)');
    expect(gated).not.toContain('headless start would be refused');

    const ungated = formatReadinessReport(reportWith('unverified'));
    expect(ungated).toContain(
      'headless start would be refused; use --allow-unverified-auth or complete verification — interactive start proceeds',
    );
    expect(ungated).toContain('Fix: Verify Claude Code CLI against tested version');
  });

  it("a non-blocked report's output contains no `Start blocked:` line", () => {
    const report = buildReadinessReport({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
      configLoad: {
        state: 'loaded',
        path: '/tmp/project/.splitbrief/config.yaml',
        warnings: [],
      },
      packageScripts: { packageJsonExists: true, scripts: { test: 'vitest run' } },
      repo: {
        isGitRepo: true,
        hasCommits: true,
        dirtyFiles: ['src/edited.ts'],
        untrackedFiles: [],
      },
      cliReadiness: [deriveCliReadiness(cliReadinessFactsFor('unverified', 'claude-code'))],
    });

    expect(report.status).not.toBe('blocked');
    expect(report.counts.blocker).toBe(0);

    const human = formatReadinessReport(report);
    expect(human).not.toContain('Start blocked:');
    expect(human).toContain(
      'headless start would be refused; use --allow-unverified-auth or complete verification — interactive start proceeds',
    );
  });

  it('prints each check as its severity and its words, without its internal id', () => {
    const human = formatReadinessReport(blockedReport());

    expect(human).not.toMatch(/config\.invalid|repo\.not-git/);
    expect(human).toContain('  blocker  Config could not be loaded.');
    expect(human).toContain('           bad config');
    expect(human).toContain(
      '           Fix: Fix .splitbrief/config.yaml or run `splitbrief init --reconfigure`.',
    );
  });

  it('names the status in words and states each count once', () => {
    const report = buildReadinessReport({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
      configLoad: { state: 'loaded', path: '/tmp/project/.splitbrief/config.yaml', warnings: [] },
      packageScripts: { packageJsonExists: true, scripts: { test: 'vitest run' } },
      repo: { isGitRepo: true, hasCommits: true, dirtyFiles: ['a.ts', 'b.ts'], untrackedFiles: [] },
      cliReadiness: [deriveCliReadiness(cliReadinessFactsFor('ready', 'claude-code'))],
    });

    const human = formatReadinessReport(report);

    expect(human.split('\n')[0]).toBe('Run readiness: ready with warnings (0 blockers, 1 warning)');
    expect(human).not.toContain('ready-with-warnings');
    expect(human).not.toContain('Advisory:');
    expect(human).toContain('  warning  Working tree has 2 changed files.');
  });

  it('pluralizes the blocker pointer by its count', () => {
    const one = buildReadinessReport({
      projectDir: '/tmp/project',
      configLoad: { state: 'missing', path: '/tmp/project/.splitbrief/config.yaml', warnings: [] },
      packageScripts: { packageJsonExists: false, scripts: {} },
      repo: { isGitRepo: true, hasCommits: true, dirtyFiles: [], untrackedFiles: [] },
    });

    expect(readinessBlockerPointer(one)).toContain('1 blocker. Resolve the blocker above');
    expect(readinessBlockerPointer(blockedReport())).toContain(
      '2 blockers. Resolve the blockers above',
    );
  });

  it('summarizes blocker messages for CLI errors', () => {
    const report = blockedReport();

    expect(readinessBlockerMessage(report)).not.toMatch(/config\.invalid|repo\.not-git/);

    const lines = readinessBlockerMessage(report).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Config could not be loaded.');
    expect(lines[1]).toBe('Project is not a git repository.');
  });

  it('points to the blocker summary in a single line without listing each blocker', () => {
    const report = blockedReport();

    const pointer = readinessBlockerPointer(report);
    expect(pointer.split('\n')).toHaveLength(1);
    expect(pointer).toContain('Run readiness blocked');
    expect(pointer).toContain(`${report.counts.blocker}`);
    expect(pointer).not.toContain('config.invalid');
    expect(pointer).not.toContain('repo.not-git');
  });

  it('strips terminal control sequences from human output while keeping the record raw', () => {
    const esc = '\u001b';
    const bel = '\u0007';
    const report = blockedReport();

    const blocker = report.sections
      .flatMap((section) => section.checks)
      .find((check) => check.severity === 'blocker');
    if (!blocker) throw new Error('missing blocker check');

    const rawSummary = `SUMVIS${esc}]0;SUMHIDE${bel}TAIL`;
    blocker.summary = rawSummary;
    blocker.details = [`DETVIS${esc}[31mDETRED`];
    blocker.fix = `FIXVIS${esc}]8;;http://evil${bel}FIXLINK`;

    const human = formatReadinessReport(report);
    expect(human).not.toContain(esc);
    expect(human).not.toContain(bel);
    expect(human).not.toContain('SUMHIDE');
    expect(human).not.toContain('evil');
    expect(human).toContain('SUMVISTAIL');
    expect(human).toContain('DETVISDETRED');
    expect(human).toContain('FIXVISFIXLINK');

    const blockerMessage = readinessBlockerMessage(report);
    expect(blockerMessage).not.toContain(esc);
    expect(blockerMessage).toContain('SUMVISTAIL');

    const record = createStartReadinessRecord(report);
    const recorded = record.checks.find((check) => check.id === blocker.id);
    expect(recorded?.summary).toBe(rawSummary);
  });
});
