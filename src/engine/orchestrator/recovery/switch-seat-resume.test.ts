import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { saveState } from '../../../core/state/persistence.js';
import type { PreparationPolicy } from '../../runners/prepare-execution/types.js';
import type { prepareExecution } from '../../runners/prepare-execution/prepare-execution.js';
import { switchSeatAndPrepareResume } from './switch-seat-resume.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const RESUME_POLICY: Extract<PreparationPolicy, { purpose: 'resume' }> = {
  purpose: 'resume',
  interaction: 'headless',
  allowRepoRunners: false,
  allowHooks: false,
  unverifiedAuth: 'denied',
};

function setup(name: string, offered: boolean) {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  const task = makeTask({ id: 'T001' });
  const state = makeImplState([task], {
    pendingRecovery: makeRecoveryIssue({
      reason: 'runner-usage-limit',
      taskId: task.id,
      affectedTaskIds: [task.id],
      availableActions: offered
        ? ['retry-same-worker', 'switch-seat', 'pause-run', 'abort-workflow']
        : ['retry-same-worker', 'pause-run', 'abort-workflow'],
      recommendedAction: offered ? 'switch-seat' : 'pause-run',
      ...(offered && {
        switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code', model: 'sonnet' }] },
      }),
    }),
  });
  saveState({ projectDir, sessionId }, state);
  return { projectDir, sessionId, state };
}

describe('switchSeatAndPrepareResume', () => {
  it('prepares the session again on the switched config', async () => {
    const { projectDir, sessionId, state } = setup('seat-swap-resume', true);
    const { bus } = makeBusRecorder();
    const prepare = vi.fn(
      async () => ({ kind: 'aborted' }) as const,
    ) as unknown as typeof prepareExecution;

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
      candidate: { tool: 'claude-code', model: 'sonnet' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare,
    });

    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') return;
    expect(result.seat).toBe('build');
    expect(result.config.implementer).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
    });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(vi.mocked(prepare).mock.calls[0]?.[0]).toMatchObject({
      existingSession: { projectDir, sessionId },
      effectiveConfig: { implementer: { tool: 'claude-code' } },
      policy: { purpose: 'resume' },
    });
  });

  it('blocks — and never prepares — when the issue offered no seat', async () => {
    const { projectDir, sessionId, state } = setup('seat-swap-resume-unoffered', false);
    const { bus } = makeBusRecorder();
    const prepare = vi.fn(
      async () => ({ kind: 'aborted' }) as const,
    ) as unknown as typeof prepareExecution;

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
      candidate: { tool: 'claude-code' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare,
    });

    expect(result).toMatchObject({ kind: 'blocked', code: 'seat-swap-unavailable' });
    expect(prepare).not.toHaveBeenCalled();
  });
});
