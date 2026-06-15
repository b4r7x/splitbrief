import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { buildReadinessReport } from './checks/build.js';
import {
  createStartReadinessRecord,
  formatReadinessReport,
  readinessBlockerMessage,
  readinessBlockerPointer,
} from './format.js';

describe('readiness formatting', () => {
  it('formats human output and compact start records without config secrets', () => {
    const report = buildReadinessReport({
      projectDir: '/tmp/project',
      config: makeConfig({
        validation: { typecheck: false },
      }),
      configLoad: {
        state: 'loaded',
        path: '/tmp/project/.diptych/config.yaml',
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
    expect(human).toContain('Advisory:');
    expect(human).not.toContain('Next action:');
    expect(human).toContain('validation.disabled');
    expect(human).not.toContain('apiKey');
    expect(record).toMatchObject({
      type: 'start-readiness',
      status: 'ready-with-warnings',
      warningCount: expect.any(Number),
    });
    expect(record.checks.some((check) => check.id === 'validation.disabled')).toBe(true);
  });

  it('summarizes blocker messages for CLI errors', () => {
    const report = buildReadinessReport({
      projectDir: '/tmp/project',
      configLoad: {
        state: 'invalid',
        path: '/tmp/project/.diptych/config.yaml',
        warnings: [],
        error: 'bad config',
      },
      packageScripts: {
        packageJsonExists: false,
        scripts: {},
      },
      repo: {
        isGitRepo: false,
        hasCommits: false,
        dirtyFiles: [],
        untrackedFiles: [],
      },
    });

    expect(readinessBlockerMessage(report)).toContain('config.invalid');
    expect(readinessBlockerMessage(report)).toContain('repo.not-git');
    expect(formatReadinessReport(report)).toContain('Required action:');
  });

  it('points to the blocker summary in a single line without listing each blocker', () => {
    const report = buildReadinessReport({
      projectDir: '/tmp/project',
      configLoad: {
        state: 'invalid',
        path: '/tmp/project/.diptych/config.yaml',
        warnings: [],
        error: 'bad config',
      },
      packageScripts: {
        packageJsonExists: false,
        scripts: {},
      },
      repo: {
        isGitRepo: false,
        hasCommits: false,
        dirtyFiles: [],
        untrackedFiles: [],
      },
    });

    const pointer = readinessBlockerPointer(report);
    expect(pointer.split('\n')).toHaveLength(1);
    expect(pointer).toContain('Run readiness blocked');
    expect(pointer).toContain(`${report.counts.blocker}`);
    expect(pointer).not.toContain('config.invalid');
    expect(pointer).not.toContain('repo.not-git');
  });
});
