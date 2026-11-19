import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getStartCommandTmp,
  probeRunnerAvailabilityMock,
  readSingleSessionArtifact,
  renderCalls,
  runHeadlessMock,
  runStart,
  setupStartCommandIntegration,
  writeLiveSession,
  writeReadyReadinessFixtures,
  writeSessionLockfile,
} from '#testing/helpers/start-command.js';
import { isCliError } from '../../../src/cli/errors.js';
import { activeFile } from '../../../src/core/paths.js';

setupStartCommandIntegration();

describe('start command — readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints blockers once and throws a one-line pointer', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    probeRunnerAvailabilityMock.mockResolvedValue([
      {
        slot: { role: 'implementer', profile: 'default' },
        provider: 'ollama',
        endpoint: 'http://localhost:11434/v1',
        verdict: { state: 'unavailable', diagnostic: 'fetch failed' },
      },
    ]);
    writeFileSync(join(tmp, 'scratch.txt'), 'local edit');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let captured: unknown;
    try {
      await runStart(['--project', tmp, 'implement X']);
    } catch (err) {
      captured = err;
    }

    const output = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(isCliError(captured)).toBe(true);
    expect(output).not.toContain('repo.active-session-live');
    expect(output.match(/Working tree has/gu)).toBeNull();
    expect(output.match(/fetch failed/gu)).toHaveLength(1);
    expect(output).not.toContain('repo.dirty-worktree');
    expect(output).not.toContain('scratch.txt');
    // Interactive feature starts mount Ink in parallel with preparation (T-037).
    // Blockers still abort before workflow navigation, and the TUI is unmounted
    // first so the report above lands on a restored terminal.
    expect(renderCalls).toEqual([
      expect.objectContaining({
        fullscreen: false,
        projectDir: tmp,
      }),
    ]);
    expect(renderCalls[0]?.unmountSignal?.aborted).toBe(true);

    const message = (captured as Error).message;
    expect(message).toContain('Run readiness blocked');
    expect(message).toContain('blocker');
    expect(message.split('\n')).toHaveLength(1);
    expect(message).not.toContain('repo.active-session-live');
  });

  it('emits readiness before headless workflow execution and persists compact session evidence', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    const stdoutChunks: string[] = [];
    let writesBeforeWorkflow = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    runHeadlessMock.mockImplementation(async () => {
      writesBeforeWorkflow = stdoutChunks.length;
    });

    await runStart(['--project', tmp, '--json', 'implement X']);

    expect(writesBeforeWorkflow).toBeGreaterThan(0);
    const firstLine = JSON.parse(stdoutChunks[0]?.trim() ?? '{}') as {
      type?: string;
      report?: { status?: string; nextAction?: { kind?: string } };
    };
    expect(firstLine.type).toBe('readiness_report');
    expect(firstLine.report?.status).toBe('ready-with-warnings');

    const readinessRecord = readSingleSessionArtifact(tmp, 'readiness.json') as {
      type?: string;
      status?: string;
      warningCount?: number;
    };
    expect(readinessRecord.type).toBe('start-readiness');
    expect(readinessRecord.status).toBe('ready-with-warnings');
    expect(readinessRecord.warningCount).toBeGreaterThan(0);
  });

  it('starts headless beside another live session and reports it as information', async () => {
    const tmp = getStartCommandTmp();
    const live = '2026-04-28-live';
    writeReadyReadinessFixtures(tmp);
    writeLiveSession(tmp, live);
    writeSessionLockfile(tmp, live);
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runStart(['--project', tmp, '--json', 'implement X']);

    expect(runHeadlessMock).toHaveBeenCalledOnce();
    const firstLine = JSON.parse(stdoutChunks[0]?.trim() ?? '{}') as {
      report?: {
        status?: string;
        sections?: unknown;
        checks?: Array<{ id: string; severity: string; remediation: string | null }>;
      };
    };
    expect(firstLine.report?.status).toBe('ready-with-warnings');
    expect(firstLine.report?.sections).toBeUndefined();
    expect(
      firstLine.report?.checks?.find(({ id }) => id === 'repo.active-session-live'),
    ).toMatchObject({
      severity: 'info',
      remediation: null,
    });
  });

  it('refuses to start when the default implementer is unreachable, before any planner call', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    probeRunnerAvailabilityMock.mockResolvedValue([
      {
        slot: { role: 'implementer', profile: 'default' },
        provider: 'ollama',
        endpoint: 'http://localhost:11434/v1',
        verdict: { state: 'unavailable', diagnostic: 'fetch failed' },
      },
    ]);
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--json', 'implement X']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect(runHeadlessMock).not.toHaveBeenCalled();
    expect(existsSync(activeFile(tmp))).toBe(false);
    const firstLine = JSON.parse(stdoutChunks[0]?.trim() ?? '{}') as {
      report?: {
        status?: string;
        checks?: Array<{ id: string; severity: string; remediation: string | null }>;
      };
    };
    expect(firstLine.report?.status).toBe('blocked');
    expect(
      firstLine.report?.checks?.find(
        (check) => check.id === 'runners.availability.implementer.default',
      ),
    ).toMatchObject({
      severity: 'blocker',
      remediation:
        'Run `ollama serve`, or choose another tool in Settings > Crew > BUILD, then run `splitbrief doctor` again.',
    });
  });
});
