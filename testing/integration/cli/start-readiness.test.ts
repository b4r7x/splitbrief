import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getStartCommandTmp,
  prepareExecutionMock,
  readSingleSessionArtifact,
  renderCalls,
  runHeadlessMock,
  runRpcMock,
  runStart,
  setupStartCommandIntegration,
  writeConfigMarker,
  writeLiveSession,
  writeReadyReadinessFixtures,
  writeSessionLockfile,
} from '#testing/helpers/start-command.js';
import { isCliError } from '../../../src/cli/errors.js';
import { activeFile, CONFIG_FILE, sessionsRoot, SPLITBRIEF_DIR } from '../../../src/core/paths.js';

setupStartCommandIntegration();

function enableTaskReview(projectDir: string): void {
  const configPath = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
  const yaml = readFileSync(configPath, 'utf8');
  writeFileSync(
    configPath,
    yaml.replace('  mode: standard', '  mode: standard\n  taskReview: every'),
  );
}

describe('start command — readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints blockers once and throws a one-line pointer', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    writeLiveSession(tmp, '2026-04-28-live');
    writeSessionLockfile(tmp, '2026-04-28-live');
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
    expect(output).toContain('repo.active-session-live');
    expect(output.match(/repo\.active-session-live/gu)).toHaveLength(1);
    expect(output).not.toContain('repo.dirty-worktree');
    expect(output).not.toContain('scratch.txt');
    expect(renderCalls).toEqual([]);

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

  it('blocks headless start before workflow execution when readiness has a blocker', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);
    writeLiveSession(tmp, '2026-04-28-live');
    writeSessionLockfile(tmp, '2026-04-28-live');
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
    expect(stdoutChunks).toHaveLength(1);
    const firstLine = JSON.parse(stdoutChunks[0]?.trim() ?? '{}') as {
      report?: {
        status?: string;
        sections?: unknown;
        checks?: Array<{ id: string; stateId: string | null; remediation: string | null }>;
      };
    };
    expect(firstLine.report?.status).toBe('blocked');
    expect(firstLine.report?.sections).toBeUndefined();
    expect(firstLine.report?.checks?.map((check) => check.id)).toContain(
      'repo.active-session-live',
    );
    const blocker = firstLine.report?.checks?.find(
      (check) => check.id === 'repo.active-session-live',
    );
    expect(blocker).toMatchObject({ stateId: null });
    expect(blocker?.remediation).toEqual(expect.any(String));
  });

  it('rejects JSON task review before preparing or activating a session', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    enableTaskReview(tmp);

    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--json', 'implement X']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain(
      'workflow.taskReview requires an interactive TUI run',
    );
    expect(prepareExecutionMock).not.toHaveBeenCalled();
    expect(runHeadlessMock).not.toHaveBeenCalled();
    expect(existsSync(activeFile(tmp))).toBe(false);
    expect(existsSync(sessionsRoot(tmp))).toBe(false);
  });

  it('emits readiness before RPC workflow execution and persists compact session evidence', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    const stdoutChunks: string[] = [];
    let writesBeforeWorkflow = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    runRpcMock.mockImplementation(async () => {
      writesBeforeWorkflow = stdoutChunks.length;
    });

    await runStart(['--project', tmp, '--rpc', 'implement X']);

    expect(writesBeforeWorkflow).toBeGreaterThan(0);
    const firstLine = JSON.parse(stdoutChunks[0]?.trim() ?? '{}') as {
      type?: string;
      data?: { type?: string; report?: { status?: string } };
    };
    expect(firstLine.type).toBe('status');
    expect(firstLine.data?.type).toBe('readiness_report');
    expect(firstLine.data?.report?.status).toBe('ready');

    const readinessRecord = readSingleSessionArtifact(tmp, 'readiness.json') as {
      type?: string;
      status?: string;
    };
    expect(readinessRecord.type).toBe('start-readiness');
    expect(readinessRecord.status).toBe('ready');
  });

  it('keeps task review available for RPC starts', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    enableTaskReview(tmp);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runStart(['--project', tmp, '--rpc', 'implement X']);

    expect(prepareExecutionMock).toHaveBeenCalledOnce();
    expect(runRpcMock).toHaveBeenCalledOnce();
    expect(runRpcMock.mock.calls[0]?.[0].prepared.config.workflow.taskReview).toBe('every');
  });

  it('rejects --json and --rpc together before workflow execution', async () => {
    const tmp = getStartCommandTmp();
    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--json', '--rpc', 'implement X']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('--json and --rpc cannot be combined');
    expect(runHeadlessMock).not.toHaveBeenCalled();
    expect(runRpcMock).not.toHaveBeenCalled();
  });
});
