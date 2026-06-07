import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import type { GateAndPromoteOpts, GateAndPromoteOutcome } from '../approval/gate-and-promote.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots.js';
import { createValidator } from '../validation.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { HINT_TIER, runEscalationTier } from './tier.js';
import type { EscalationContext } from './types.js';

const gateAndPromoteChangedFiles =
  vi.fn<(opts: GateAndPromoteOpts) => Promise<GateAndPromoteOutcome>>();

vi.mock('../approval/gate-and-promote.js', () => ({
  gateAndPromoteChangedFiles: (opts: GateAndPromoteOpts) => gateAndPromoteChangedFiles(opts),
}));

const runRetryStep = vi.fn();

vi.mock('./step.js', () => ({
  runRetryStep: (...args: unknown[]) => runRetryStep(...args),
}));

let dirs: string[] = [];

afterEach(() => {
  gateAndPromoteChangedFiles.mockReset();
  runRetryStep.mockReset();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('hint-tier-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-hint-tier';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

async function makeCtx(projectDir: string, sessionId: string): Promise<EscalationContext> {
  const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
  const { callbacks } = makeCallbacks();
  const { bus } = makeBusRecorder();
  return {
    projectDir,
    sessionId,
    config: makeNoValidationConfig({ workflow: { commitStrategy: 'none' } }),
    callbacks,
    bus,
    planner: makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'try importing foo',
        code: null,
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    }),
    context: defaultContext,
    implementer: makeImplementer(),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
    taskStartSnapshot,
    dependsOnFiles: [],
  };
}

describe('runEscalationTier hint tier gate handling', () => {
  it('does not retry after gate denial', async () => {
    const { projectDir, sessionId } = setupProject();
    const ctx = await makeCtx(projectDir, sessionId);
    const task = makeTask();
    const state = makeImplState([task]);

    gateAndPromoteChangedFiles.mockResolvedValue({
      outcome: 'gate-denied',
      state,
      decision: { allow: false, changedFiles: ['src/a.ts'], reason: 'user denied' },
    });

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(runRetryStep).not.toHaveBeenCalled();
    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 1 });
    expect(outcome.lastError).toBe('user denied');
  });

  it('does not retry after gate error', async () => {
    const { projectDir, sessionId } = setupProject();
    const ctx = await makeCtx(projectDir, sessionId);
    const task = makeTask();
    const state = makeImplState([task]);

    gateAndPromoteChangedFiles.mockResolvedValue({
      outcome: 'error',
      state,
      error: new Error('snapshot failed'),
    });

    await expect(
      runEscalationTier(HINT_TIER, {
        ctx,
        task,
        state,
        lastError: 'validation failed',
        priorAttempts: 0,
      }),
    ).rejects.toThrow('snapshot failed');
    expect(runRetryStep).not.toHaveBeenCalled();
  });

  it('does not retry after abort', async () => {
    const { projectDir, sessionId } = setupProject();
    const ctx = await makeCtx(projectDir, sessionId);
    const task = makeTask();
    const state = makeImplState([task]);

    gateAndPromoteChangedFiles.mockResolvedValue({
      outcome: 'aborted',
      state,
    });

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(runRetryStep).not.toHaveBeenCalled();
    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 1 });
  });

  it('retries after gate allow', async () => {
    const { projectDir, sessionId } = setupProject();
    const ctx = await makeCtx(projectDir, sessionId);
    const task = makeTask();
    const state = makeImplState([task]);

    gateAndPromoteChangedFiles.mockResolvedValue({
      outcome: 'allow',
      state,
      changedFiles: ['src/a.ts'],
    });
    runRetryStep.mockResolvedValue({
      state,
      task,
      lastError: 'validation failed',
      attempts: 1,
      result: { completed: true, method: 'escalated-hint', attempts: 1 },
    });

    await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(runRetryStep).toHaveBeenCalledOnce();
    expect(existsSync(projectDir)).toBe(true);
  });
});
