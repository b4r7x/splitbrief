import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { LADDER, type LadderRungId } from '../../../core/pipeline-spec/ladder.js';
import { DEFAULT_LOCAL_RETRIES } from '../../../core/pipeline-spec/retries.js';
import { handleRetryAndEscalation } from './handle.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';

// The escalation tiers acquire from the run isolation handle; on the copying
// strategy under parallel full-suite load that staged-copy IO can push these
// cases past the 10s default, so widen the timeout for this file (cases pass
// in ~8-25s in isolation).
vi.setConfig({ testTimeout: 60_000 });

let dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('escalation-handle-trust-home');
});

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
  trustHome.restore();
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'escalation-test',
    sessionId: 'sess-esc',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  let state = makeImplState([task]);
  state = transition(state, { type: 'TASK_SENT' });
  return state;
}

// The tier number each escalating LADDER rung publishes on its `escalate` event.
// The `takeover` rung has no entry: the engine never dispatches the planner as
// an implementer, so no escalating tier answers for it.
const ESCALATION_TIERS: Partial<Record<LadderRungId, 0 | 1>> = {
  intermediate: 0,
  hint: 1,
};

// Validation disabled so runValidationWithEvents returns [] → treated as all-pass.
// Commit strategy 'none' so we don't need a dirty repo for every happy-path test.
const defaultWorkflow = { maxRetries: 2 as const };

describe('handleRetryAndEscalation', () => {
  it('retry succeeds on attempt 1 → completed with method=local', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const task = makeTask();
    const state = makeValidatingState();
    const implementer = makeImplementer(); // default retry returns success

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        planner,
        callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('local');
  });

  it('all local retries fail → hint retry also fails → failed with the worker attempts and no planner takeover', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    // Both local retry attempts AND the hint-tier retry fail: no success anywhere.
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const escalateFull = vi.fn();
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'use x',
        code: null,
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
      escalateFull,
    });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'error',
      currentState: state,
    });

    // Local retry (1) exhausted → hint tier retry (2) → the ladder ends there,
    // carrying the last rung's error and the planner's answer.
    expect(result).toEqual({
      completed: false,
      method: 'failed',
      attempts: 2,
      lastError: 'still broken',
      plannerHint: 'use x',
      hintRungRan: true,
      plannerVerdict: 'answer',
    });
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 2)).toBeUndefined();
    expect(escalateFull).not.toHaveBeenCalled();
  });

  it('stubbed ladder publishes task_retry × DEFAULT_LOCAL_RETRIES then task_escalating tiers in LADDER order', async () => {
    const { projectDir, sessionId } = setupProject();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken' }),
    });
    const escalateFull = vi.fn();
    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: true, output: 'use x', code: null, usage: null }),
      escalateFull,
    });

    await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: DEFAULT_LOCAL_RETRIES } }),
        planner,
        implementer,
        bus,
      }),
      task,
      initialError: 'error',
      currentState: makeValidatingState(),
    });

    expect(busEvents.filter((e) => e.type === 'task_retry')).toHaveLength(DEFAULT_LOCAL_RETRIES);
    expect(busEvents.filter((e) => e.type === 'task_escalating')).toHaveLength(1);
    // No intermediate profile is configured, so the optional rung is skipped.
    const expected = LADDER.filter((rung) => rung.optional !== true).flatMap((rung) => {
      const tier = ESCALATION_TIERS[rung.id];
      return tier === undefined ? [] : [tier];
    });
    expect(busEvents.filter((e) => e.type === 'escalate').map((e) => e.tier)).toEqual(expected);
    expect(escalateFull).not.toHaveBeenCalled();
  });

  it('runs tier-1 hint escalation with a staged projectDir and sandbox env', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const escalateHint = vi.fn().mockImplementation(async (opts) => {
      expect(opts.projectDir).not.toBe(projectDir);
      expect(opts.fileIgnoreProjectDir).toBe(projectDir);
      // The env belongs to the staged directory. XDG_CACHE_HOME is the invariant
      // to assert: HOME is the host's for a channel whose credential is an OS
      // keychain item, which is what a macOS Claude Code planner uses, and TMPDIR
      // sits in the system temp directory outside every project.
      expect(opts.sandboxEnv?.XDG_CACHE_HOME?.startsWith(opts.projectDir)).toBe(true);
      return { success: false, output: 'hint text', code: null, usage: null };
    });

    const planner = makePlanner({ escalateHint });

    await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'error',
      currentState: state,
    });

    expect(escalateHint).toHaveBeenCalled();
  });

  it('hint-assisted retry succeeds → completed with method=escalated-hint', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi
        .fn()
        // Local retry fails (attempt 1).
        .mockResolvedValueOnce({
          success: false,
          output: '',
          error: 'fail',
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        // Hint-assisted retry succeeds.
        .mockResolvedValueOnce({
          success: true,
          output: 'fixed',
          usage: { inputTokens: 20, outputTokens: 10 },
        }),
    });

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'try adding import',
        code: null,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'error',
      currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-hint');
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
  });

  it('retry promotion conflicts ask for user-edit resolution and do not escalate', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      file: 'src/main.ts',
      action: 'modify',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    const onUserEditConflict = vi.fn().mockResolvedValue('pause');
    const { callbacks } = makeCallbacks({
      onTieredApproval: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, '.env.local'), 'export const value = "user";\n');
        return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'ok' };
      }),
      onUserEditConflict,
    });
    const { bus, events: busEvents } = makeBusRecorder();

    const implementer = makeImplementer({
      retry: vi.fn().mockImplementation(async ({ projectDir: runDir }: { projectDir: string }) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        writeFileSync(join(runDir, '.env.local'), 'export const value = "retry";\n');
        return { success: true, output: 'fixed', usage: { inputTokens: 20, outputTokens: 10 } };
      }),
    });
    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1 },
          approval: {
            enabled: true,
            feedRejectionsToPlanner: false,
          },
        }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'validation failed',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(onUserEditConflict).not.toHaveBeenCalled();
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'approval-promotion-conflict',
      taskId: 'T001',
      files: ['.env.local'],
    });
    expect(busEvents.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'changed-during-approval-promotion',
        files: ['.env.local'],
      },
    });
  });

  it('discards a successful staged retry without promotion when the workflow aborts after invoke', async () => {
    const { projectDir, sessionId } = setupProject();
    const targetPath = join(projectDir, 'src', 'signal.ts');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(targetPath, 'original\n');
    const task = makeTask({ id: 'T012', file: 'src/signal.ts' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const controller = new AbortController();

    let retryEntered: () => void;
    const retryEnteredPromise = new Promise<void>((resolve) => {
      retryEntered = resolve;
    });

    const implementer = makeImplementer({
      retry: vi
        .fn()
        .mockImplementation(
          async ({ projectDir: runDir, signal }: { projectDir: string; signal?: AbortSignal }) => {
            mkdirSync(join(runDir, 'src'), { recursive: true });
            writeFileSync(join(runDir, 'src', 'signal.ts'), 'staged mutation\n');
            retryEntered();
            await new Promise<void>((resolve) => {
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return {
              success: true,
              output: 'fixed',
              usage: { inputTokens: 12, outputTokens: 6 },
            };
          },
        ),
    });

    const run = handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner: makePlanner(),
        callbacks,
        implementer,
        bus,
        signal: controller.signal,
      }),
      task,
      initialError: 'validation failed',
      currentState: state,
    });

    await retryEnteredPromise;
    controller.abort();
    const { result } = await run;

    expect(result.completed).toBe(false);
    expect(readFileSync(targetPath, 'utf-8')).toBe('original\n');
    expect(busEvents.find((e) => e.type === 'task_completed')).toBeUndefined();
  });

  it('an exhausted ladder fails without advancing the task or taking the brief over', async () => {
    const { projectDir, sessionId } = setupProject();
    // Create a dirty file so the exhausted ladder has real worktree state to leave untouched.
    writeFileSync(join(projectDir, 'task-file.ts'), 'pending content');
    const task = makeTask({ file: 'task-file.ts', action: 'create' });
    const state = makeValidatingState();
    // Update task list with the file-matching task so shutdown cleanup finds a real path.
    const stateWithTask: WorkflowState = {
      ...state,
      tasks: [task],
    };

    const { callbacks } = makeCallbacks();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'fail',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const escalateFull = vi.fn();
    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
      escalateFull,
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      task,
      initialError: 'error',
      currentState: stateWithTask,
    });

    expect(result).toMatchObject({ completed: false, method: 'failed', attempts: 2 });
    expect(escalateFull).not.toHaveBeenCalled();
    expect(finalState.currentTaskIndex).toBe(0);
    expect(finalState.tasks[0]?.status).toBe('pending');
  });

  it('a no-change retry ends the local rung early and the hinted retry carries the hint out', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi
        .fn()
        .mockResolvedValueOnce({
          success: false,
          output: 'I could not find it.',
          error: 'exited without changing any files',
          outcome: 'no-staged-change',
        })
        .mockResolvedValue({ success: false, output: '', error: 'still broken' }),
    });
    const escalateHint = vi
      .fn()
      .mockResolvedValue({ success: true, output: 'use a default', code: null, usage: null });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        planner: makePlanner({ escalateHint }),
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    expect(implementer.retry).toHaveBeenCalledTimes(2);
    expect(escalateHint).toHaveBeenCalledTimes(1);
    expect(escalateHint).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'type error', handBack: 'I could not find it.' }),
    );
    expect(result).toEqual({
      completed: false,
      method: 'failed',
      attempts: 2,
      lastError: 'still broken',
      handBack: 'I could not find it.',
      plannerHint: 'use a default',
      hintRungRan: true,
      plannerVerdict: 'answer',
    });
  });

  it('an empty hint spends no implementer attempt and keeps the error the brief died on', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: 'I could not find it.',
        error: 'exited without changing any files',
        outcome: 'no-staged-change',
      }),
    });
    const escalateHint = vi
      .fn()
      .mockResolvedValue({ success: false, output: '', code: null, usage: null });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        planner: makePlanner({ escalateHint }),
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(escalateHint).toHaveBeenCalledTimes(1);
    expect(busEvents.filter((e) => e.type === 'escalate')).toEqual([]);
    expect(result).toEqual({
      completed: false,
      method: 'failed',
      attempts: 1,
      lastError: 'type error',
      handBack: 'I could not find it.',
    });
  });

  it('a planner that cannot hint gets no hint rung at all', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken' }),
    });
    const escalateHint = vi.fn();
    const planner = makePlanner({
      escalateHint,
      capabilities: { ...makePlanner().capabilities, supportsHintEscalation: false },
    });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    expect(escalateHint).not.toHaveBeenCalled();
    expect(busEvents.find((e) => e.type === 'task_escalating')).toBeUndefined();
    expect(busEvents.find((e) => e.type === 'escalate')).toBeUndefined();
    expect(
      busEvents.find(
        (e) => e.type === 'planner_status' && e.status === 'running' && e.phase === 'escalating',
      ),
    ).toBeUndefined();
    expect(result).toEqual({
      completed: false,
      method: 'failed',
      attempts: 1,
      lastError: 'still broken',
    });
  });

  it('a first attempt that stopped with a hand-back goes to the planner before any retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const config = makeNoValidationConfig({
      workflow: defaultWorkflow,
      escalation: {
        intermediateProvider: 'ollama',
        intermediateModel: 'x-ai/grok-4',
        enabled: true,
      },
    });
    const implementer = makeImplementer({ retry: vi.fn() });
    const hint = 'VERDICT: brief — the consumer is out of scope';
    const escalateHint = vi
      .fn()
      .mockResolvedValue({ success: true, output: hint, code: null, usage: null });
    const createImplementer = vi.fn();

    const { result, state } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        planner: makePlanner({ escalateHint }),
        callbacks,
        implementer,
        createImplementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'exited without changing any files',
      initialFailure: {
        outcome: 'no-staged-change',
        runner: config.implementer,
        handBack: 'May I edit src/consumer.ts?',
      },
      currentState: makeValidatingState(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(createImplementer).not.toHaveBeenCalled();
    expect(busEvents.filter((e) => e.type === 'task_retry')).toEqual([]);
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 0)).toBeUndefined();
    expect(escalateHint).toHaveBeenCalledTimes(1);
    expect(escalateHint).toHaveBeenCalledWith(
      expect.objectContaining({ handBack: 'May I edit src/consumer.ts?' }),
    );
    expect(result).toEqual({
      completed: false,
      method: 'failed',
      attempts: 0,
      lastError: 'exited without changing any files',
      handBack: 'May I edit src/consumer.ts?',
      plannerHint: hint,
      plannerVerdict: 'brief',
    });
    expect(state.pendingRecovery).toBeUndefined();
  });

  it('pre_escalation deny skips the escalation tiers and attributes the retry-exhausted recovery message to the hook', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    writeFileSync(
      join(projectDir, 'deny-escalation.mjs'),
      "console.log(JSON.stringify({ decision: 'deny', message: 'policy: escalation not allowed' }));\n",
    );

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const escalateHint = vi.fn();
    const escalateFull = vi.fn();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({ escalateHint, escalateFull });
    const hooks: HooksConfig = {
      pre_escalation: [
        {
          kind: 'command',
          command: 'node',
          args: ['deny-escalation.mjs'],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1 },
          hooks,
        }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    // Escalation tiers must never run once the hook denies.
    expect(escalateHint).not.toHaveBeenCalled();
    expect(escalateFull).not.toHaveBeenCalled();
    expect(busEvents.find((e) => e.type === 'escalate')).toBeUndefined();

    // The recovery is attributed to the hook, not silently mislabeled as retry exhaustion.
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });
    expect(finalState.pendingRecovery?.message).toBe(
      'T001 escalation blocked by pre_escalation hook: policy: escalation not allowed',
    );
    expect(finalState.pendingRecovery?.facts?.validationSummary).toBe('still broken');
    expect(finalState.pendingRecovery?.facts?.escalationBlockedBy).toBe(
      'policy: escalation not allowed',
    );
    expect(finalState.pendingRecovery?.message).not.toContain('exhausted its retries');
    expect(formatRecoveryHeadline(finalState.pendingRecovery!)).toBe(
      finalState.pendingRecovery?.message,
    );
    expect(busEvents.find((e) => e.type === 'recovery_prompted')).toMatchObject({
      type: 'recovery_prompted',
      reason: 'retry-exhausted',
    });
  });

  it('a refused command line halts the ladder with a recipe-invalid recovery', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask({ id: 'T007' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    const escalateHint = vi.fn();
    const escalateFull = vi.fn();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: "error: unknown option '--nope'",
        outcome: 'implementer-recipe-invalid',
      }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        planner: makePlanner({ escalateHint, escalateFull }),
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(escalateHint).not.toHaveBeenCalled();
    expect(escalateFull).not.toHaveBeenCalled();
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'implementer-recipe-invalid',
      taskId: 'T007',
    });
    expect(busEvents.find((e) => e.type === 'recovery_prompted')).toMatchObject({
      reason: 'implementer-recipe-invalid',
    });
  });
});
