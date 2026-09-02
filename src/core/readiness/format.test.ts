import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliReadinessFactsFor } from '#testing/helpers/factories/detection.js';
import { buildReadinessReport } from './checks/build.js';
import {
  createStartReadinessRecord,
  formatReadinessReport,
  readinessBlockerMessage,
  readinessBlockerPointer,
} from './format.js';
import { deriveCliReadiness } from '../schemas/readiness.js';

describe('readiness formatting', () => {
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
        validation: { typecheck: false },
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
    expect(human).toContain('Required action: Set up the configured runner');
    expect(human).not.toContain('Advisory:');
    expect(human).not.toContain('Next action:');
    expect(human).toContain('runners.cli.claude-code.readiness');
    expect(human).toContain('validation.disabled');
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
    expect(record.checks.some((check) => check.id === 'validation.disabled')).toBe(true);
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
    expect(gated).toContain('start can continue');

    const ungated = formatReadinessReport(reportWith('unverified'));
    expect(ungated).not.toContain('start can continue');
    expect(ungated).toContain(
      'headless start would be refused; use --allow-unverified-auth or complete verification — interactive start proceeds',
    );
    expect(ungated).toContain('Fix: Verify claude-code against tested version');
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

  it('summarizes blocker messages for CLI errors', () => {
    const report = blockedReport();

    expect(readinessBlockerMessage(report)).toContain('config.invalid');
    expect(readinessBlockerMessage(report)).toContain('repo.not-git');
    expect(formatReadinessReport(report)).toContain('Required action:');

    const lines = readinessBlockerMessage(report).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^config\.invalid: /);
    expect(lines[1]).toMatch(/^repo\.not-git: /);
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
    report.nextAction = {
      ...report.nextAction,
      label: `LBLVIS${esc}]0;LBLHIDE${bel}`,
      command: `cmd${esc}[2J`,
    };

    const human = formatReadinessReport(report);
    expect(human).not.toContain(esc);
    expect(human).not.toContain(bel);
    expect(human).not.toContain('SUMHIDE');
    expect(human).not.toContain('LBLHIDE');
    expect(human).not.toContain('evil');
    expect(human).toContain('SUMVISTAIL');
    expect(human).toContain('DETVISDETRED');
    expect(human).toContain('FIXVISFIXLINK');
    expect(human).toContain('LBLVIS');

    const blockerMessage = readinessBlockerMessage(report);
    expect(blockerMessage).not.toContain(esc);
    expect(blockerMessage).toContain('SUMVISTAIL');

    const record = createStartReadinessRecord(report);
    const recorded = record.checks.find((check) => check.id === blocker.id);
    expect(recorded?.summary).toBe(rawSummary);
  });
});
