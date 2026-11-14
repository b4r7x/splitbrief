import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { transition } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { resetLoggerForTests } from '../../../lib/logger.js';
import {
  CLOSE_RUN_SESSION_ID,
  setupCloseRunWorkspace,
} from '#testing/helpers/close-run-workspace.js';
import { enableDebugLog, loggedDiagnostics } from '#testing/helpers/debug-log.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { removeClosedRunWorkspaces } from './closed-runs.js';
import { readWorkspaceRecord } from './retention.js';

const SESSION_ID = CLOSE_RUN_SESSION_ID;
const { dirs, openWorkspaceRun } = setupCloseRunWorkspace();

describe('removeClosedRunWorkspaces', () => {
  it.each([
    {
      closedReason: 'ended',
      close: (state: WorkflowState) => transition(state, { type: 'CLOSE_RUN' }),
    },
    {
      closedReason: 'discarded',
      close: (state: WorkflowState) => transition(state, { type: 'CLOSE_RUN', as: 'discarded' }),
    },
    {
      closedReason: 'applied',
      close: (state: WorkflowState) =>
        transition(
          transition(
            {
              ...state,
              phase: 'complete',
              reviewStatus: 'passed',
            },
            { type: 'APPLY_START', backupId: 'backup-1' },
          ),
          { type: 'APPLY_DONE', files: [] },
        ),
    },
  ] as const)(
    'removes a closed worktree run ($closedReason) with its record still set',
    { timeout: 60_000 },
    async ({ close }) => {
      const { ref, state, workspaceDir } = await openWorkspaceRun('worktree');
      saveState(ref, close(state));

      expect(await readWorkspaceRecord(ref)).not.toBeNull();
      expect(existsSync(workspaceDir)).toBe(true);

      await removeClosedRunWorkspaces(ref.projectDir);

      expect(existsSync(workspaceDir)).toBe(false);
      const wtList = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: ref.projectDir,
        encoding: 'utf8',
      });
      expect(wtList).not.toContain(workspaceDir);
      const branches = execFileSync('git', ['branch', '--list'], {
        cwd: ref.projectDir,
        encoding: 'utf8',
      });
      expect(branches).not.toContain(`splitbrief/${SESSION_ID}`);
      expect(await readWorkspaceRecord(ref)).toBeNull();
    },
  );

  it('removes a closed staged-copy run with its record still set', {
    timeout: 60_000,
  }, async () => {
    const { ref, state, workspaceDir } = await openWorkspaceRun('staged-copy');
    saveState(ref, transition(state, { type: 'CLOSE_RUN' }));

    expect(await readWorkspaceRecord(ref)).not.toBeNull();
    expect(existsSync(workspaceDir)).toBe(true);

    await removeClosedRunWorkspaces(ref.projectDir);

    expect(existsSync(workspaceDir)).toBe(false);
    expect(await readWorkspaceRecord(ref)).toBeNull();
  });

  it('an open run and a ready-to-apply run with records keep their workspaces', {
    timeout: 60_000,
  }, async () => {
    const openRun = await openWorkspaceRun('worktree');
    expect(await readWorkspaceRecord(openRun.ref)).not.toBeNull();
    expect(existsSync(openRun.workspaceDir)).toBe(true);

    await removeClosedRunWorkspaces(openRun.ref.projectDir);

    expect(existsSync(openRun.workspaceDir)).toBe(true);
    expect(await readWorkspaceRecord(openRun.ref)).not.toBeNull();

    const readyRun = await openWorkspaceRun('worktree');
    const readyState: WorkflowState = {
      ...readyRun.state,
      phase: 'complete',
      reviewStatus: 'passed',
    };
    saveState(readyRun.ref, readyState);
    expect(await readWorkspaceRecord(readyRun.ref)).not.toBeNull();
    expect(existsSync(readyRun.workspaceDir)).toBe(true);

    await removeClosedRunWorkspaces(readyRun.ref.projectDir);

    expect(existsSync(readyRun.workspaceDir)).toBe(true);
    expect(await readWorkspaceRecord(readyRun.ref)).not.toBeNull();
  });

  // A kept record warns again at each start; a gone path this checkout does not own clears it.
  it('a closed run whose state.workspace.path does not match its confined path clears its record silently for a missing foreign workspace', {
    timeout: 60_000,
  }, async () => {
    const { ref, state, workspaceDir } = await openWorkspaceRun('worktree');
    const closedState: WorkflowState = {
      ...transition(state, { type: 'CLOSE_RUN' }),
      workspace: {
        ...state.workspace!,
        path: join(ref.projectDir, 'mismatched-path'),
      },
    };
    saveState(ref, closedState);
    expect(await readWorkspaceRecord(ref)).not.toBeNull();

    const logDir = createTempDir('close-run-log-');
    dirs.push(logDir);
    enableDebugLog(logDir);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(removeClosedRunWorkspaces(ref.projectDir)).resolves.toBeUndefined();
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(loggedDiagnostics(logDir)).toEqual([]);
      expect(await readWorkspaceRecord(ref)).toBeNull();
      expect(existsSync(workspaceDir)).toBe(true);

      stderrSpy.mockClear();
      await expect(removeClosedRunWorkspaces(ref.projectDir)).resolves.toBeUndefined();
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(loggedDiagnostics(logDir)).toEqual([]);
      expect(await readWorkspaceRecord(ref)).toBeNull();
      expect(existsSync(workspaceDir)).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      resetLoggerForTests();
    }
  });
});
