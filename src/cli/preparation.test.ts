import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { buildConfigChecks } from '../core/readiness/checks/config.js';
import { buildRepoChecks } from '../core/readiness/checks/repo.js';
import { buildRunnerChecks } from '../core/readiness/checks/runner/build.js';
import type { ReadinessReport } from '../core/readiness/types.js';
import { preparedExecutionOrThrow } from './preparation.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupTempDir(directory);
});

describe('preparedExecutionOrThrow', () => {
  const IGNORED_FLAG =
    "--planner-api-key-env is ignored: the planner 'cli' runner does not use it.";

  function specOutcome(projectDir: string) {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', temperature: 0.2 },
      implementer: { kind: 'shell', command: 'node', model: 'test', temperature: 0.2 },
    });
    const execution = makePreparedExecution({
      projectDir,
      sessionId: 'session-spec-warnings',
      feature: 'plan the readme',
      config,
      purpose: 'spec',
    });
    const report: ReadinessReport = {
      ...execution.report,
      status: 'ready-with-warnings',
      sections: [
        {
          id: 'config',
          title: 'Config',
          checks: buildConfigChecks({
            state: 'loaded',
            path: join(projectDir, '.splitbrief', 'config.yaml'),
            warnings: [
              {
                kind: 'ignored-flag',
                notice: IGNORED_FLAG,
                fix: 'Remove the flag from the command.',
              },
            ],
          }),
        },
        {
          id: 'runners',
          title: 'Runners',
          checks: buildRunnerChecks({ config, seatImageFact: () => undefined }),
        },
        {
          id: 'repo',
          title: 'Repository',
          checks: buildRepoChecks(
            { isGitRepo: true, hasCommits: true, dirtyFiles: ['README.md'], untrackedFiles: [] },
            'none',
          ),
        },
      ],
    };
    return { kind: 'prepared', execution: { ...execution, report } } as const;
  }

  function captureStderr(): string[] {
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    return chunks;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the flags and settings the named seat does not apply to stderr, once each with its fix', () => {
    const projectDir = createTempDir('prepared-execution-or-throw');
    directories.push(projectDir);
    const stderr = captureStderr();

    preparedExecutionOrThrow(specOutcome(projectDir), 'prose', 'planner');

    expect(stderr).toEqual([
      `${IGNORED_FLAG}\n`,
      'Fix: Remove the flag from the command.\n',
      'PLAN: the temperature setting is not applied: Claude Code CLI takes no temperature.\n',
      'Fix: Delete temperature from planner in .splitbrief/config.yaml.\n',
    ]);
  });

  it('writes nothing when the command names no seat, because the run tells its warnings', () => {
    const projectDir = createTempDir('prepared-execution-or-throw-run');
    directories.push(projectDir);
    const stderr = captureStderr();

    preparedExecutionOrThrow(specOutcome(projectDir), 'structured');

    expect(stderr).toEqual([]);
  });
});
