import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../events/types.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createValidator } from '../validation/run.js';
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
import type { OrchestratorCallbacks } from '../types.js';
import { HINT_TIER, runEscalationTier } from './tier.js';
import type { EscalationContext } from './types.js';

vi.setConfig({ testTimeout: 30_000 });

const RETRY_MARKER = 'src/hello.ts';
const OUT_OF_SCOPE_FILE = 'src/other.ts';

let dirs: string[] = [];

afterEach(() => {
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

function writeFileIn(dir: string, relPath: string, contents: string): void {
  const target = join(dir, relPath);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(target, contents);
}

type CtxOptions = {
  callbacks: OrchestratorCallbacks;
  hintWritesOutOfScope?: boolean;
  hintRejects?: boolean;
  signal?: AbortSignal;
};

async function makeCtx(
  projectDir: string,
  sessionId: string,
  opts: CtxOptions,
): Promise<{ ctx: EscalationContext; events: EngineEvent[] }> {
  const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
  const { bus, events } = makeBusRecorder();
  const escalateHint = vi.fn().mockImplementation(async ({ projectDir: stagedDir }) => {
    if (opts.hintRejects) throw new Error('snapshot failed');
    if (opts.hintWritesOutOfScope) {
      writeFileIn(stagedDir, OUT_OF_SCOPE_FILE, 'export const value = "hint";\n');
    }
    return {
      success: true,
      output: 'try importing foo',
      code: null,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  });
  const ctx: EscalationContext = {
    projectDir,
    sessionId,
    config: makeNoValidationConfig({
      workflow: { commitStrategy: 'none' },
      approval: { enabled: true, feedRejectionsToPlanner: false },
    }),
    callbacks: opts.callbacks,
    bus,
    planner: makePlanner({ escalateHint }),
    context: defaultContext,
    implementer: makeImplementer({
      retry: vi.fn().mockImplementation(async ({ projectDir: runDir }: { projectDir: string }) => {
        writeFileIn(runDir, RETRY_MARKER, 'export const greeting = "retried";\n');
        return { success: true, output: 'fixed', usage: { inputTokens: 20, outputTokens: 10 } };
      }),
    }),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
    taskStartSnapshot,
    dependsOnFiles: [],
    ...(opts.signal && { signal: opts.signal }),
  };
  return { ctx, events };
}

describe('runEscalationTier hint tier gate handling', () => {
  it('does not retry after gate denial', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks({
      onTieredApproval: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'user denied' }),
    });
    const { ctx, events } = await makeCtx(projectDir, sessionId, {
      callbacks,
      hintWritesOutOfScope: true,
    });
    const task = makeTask();
    const state = makeImplState([task]);

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 1 });
    expect(outcome.lastError).toBe('user denied');
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(false);
    expect(events.some((e) => e.type === 'approval_rejected')).toBe(true);
    expect(
      events.some((e) => e.type === 'error' && e.message.includes('blocked by approval gate')),
    ).toBe(true);
  });

  it('does not retry after gate error', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, { callbacks, hintRejects: true });
    const task = makeTask();
    const state = makeImplState([task]);

    await expect(
      runEscalationTier(HINT_TIER, {
        ctx,
        task,
        state,
        lastError: 'validation failed',
        priorAttempts: 0,
      }),
    ).rejects.toThrow('snapshot failed');
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(false);
  });

  it('does not retry after abort', async () => {
    const { projectDir, sessionId } = setupProject();
    const controller = new AbortController();
    controller.abort();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, {
      callbacks,
      signal: controller.signal,
    });
    const task = makeTask();
    const state = makeImplState([task]);

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 1 });
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(false);
  });

  it('retries after gate allow', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, { callbacks });
    const task = makeTask();
    const state = makeImplState([task]);

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(outcome.result).toMatchObject({ completed: true, method: 'escalated-hint' });
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(true);
  });
});
