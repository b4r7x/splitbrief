import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeOpenAiSseResponse } from '#testing/helpers/fixtures/openai-sse.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { handleRetryAndEscalation } from './escalation.js';
import type { WorkflowSinks } from '../types.js';
import { createValidator } from '../validation.js';

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'standard',
} as const;

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

const TEST_VALIDATOR = createValidator();

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('escalation-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-esc';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  let state = createInitialState('feat');
  state = transition(state, { type: 'START' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks: [task] });
  state = transition(state, { type: 'BRIEFS_READY', tasks: [task] });
  state = transition(state, { type: 'APPROVE_BRIEFS' });
  state = transition(state, { type: 'TASK_SENT' });
  return state;
}

// Validation disabled so runValidationWithEvents returns [] → treated as all-pass.
// Commit strategy 'none' so we don't need a dirty repo for every happy-path test.
const defaultWorkflow = { maxRetries: 2, commitStrategy: 'none' as const };

describe('handleRetryAndEscalation', () => {
  it('retry succeeds on attempt 1 → completed with method=local', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const task = makeTask();
    const state = makeValidatingState();
    const implementer = makeImplementer(); // default retry returns success

    const { result } = await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus: makeBusRecorder().bus,
      },
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('local');
  });

  it('all local retries fail → hint retry also fails → result not completed', async () => {
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

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'use x',
        code: null,
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
      task,
      initialError: 'error',
      currentState: state,
    });

    // Local retries exhausted → hint tier → full tier → all failed.
    expect(result.completed).toBe(false);
    const escalateTier1 = busEvents.find((e) => e.type === 'escalate' && e.tier === 1);
    const escalateTier2 = busEvents.find((e) => e.type === 'escalate' && e.tier === 2);
    expect(escalateTier1).toBeDefined();
    expect(escalateTier2).toBeDefined();
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
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
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
        writeFileSync(join(projectDir, 'src/other.ts'), 'export const value = "user";\n');
        return { decision: 'allow', scope: 'once' };
      }),
      onUserEditConflict,
    });
    const { bus, events: busEvents } = makeBusRecorder();

    const implementer = makeImplementer({
      retry: vi.fn().mockImplementation(async ({ projectDir: runDir }: { projectDir: string }) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        writeFileSync(join(runDir, 'src/other.ts'), 'export const value = "retry";\n');
        return { success: true, output: 'fixed', usage: { inputTokens: 20, outputTokens: 10 } };
      }),
    });
    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1, commitStrategy: 'none' },
          approval: { enabled: true, feedRejectionsToPlanner: false },
        }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
      task,
      initialError: 'validation failed',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(onUserEditConflict).not.toHaveBeenCalled();
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'approval-promotion-conflict',
      taskId: 'T001',
      files: ['src/other.ts'],
    });
    expect(busEvents.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'changed-during-approval-promotion',
        files: ['src/other.ts'],
      },
    });
  });

  it('Tier 2 full escalation: planner.escalateFull succeeds → completed with method=escalated-full', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'fail',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'hint',
        code: null,
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
      escalateFull: vi.fn().mockResolvedValue({
        success: true,
        output: 'full code',
        code: 'code',
        usage: { inputTokens: 200, outputTokens: 100 },
      }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
      task,
      initialError: 'error',
      currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-full');
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 2)).toBeDefined();
  });

  it('full escalation fails without advancing the task in the retry pipeline', async () => {
    const { projectDir, sessionId } = setupProject();
    // Create a dirty file so a failed full escalation has real worktree state to leave untouched.
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

    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus: makeBusRecorder().bus,
      },
      task,
      initialError: 'error',
      currentState: stateWithTask,
    });

    expect(result.completed).toBe(false);
    expect(result.method).toBe('failed');
    expect(finalState.currentTaskIndex).toBe(0);
    expect(finalState.tasks[0]?.status).toBe('pending');
  });
});

describe('handleRetryAndEscalation — Tier 0 intermediate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no intermediate provider configured → skips Tier 0 entirely, proceeds to Tier 1', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'fail',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'hint',
        code: null,
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
      task,
      initialError: 'error',
      currentState: state,
    });

    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 0)).toBeUndefined();
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escalation.enabled = false → skips Tier 0, proceeds to Tier 1', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'fail',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'hint',
        code: null,
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1, commitStrategy: 'none' },
          escalation: {
            intermediateProvider: 'openrouter',
            intermediateModel: 'x-ai/grok-4',
            enabled: false,
          },
        }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
      task,
      initialError: 'error',
      currentState: state,
    });

    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 0)).toBeUndefined();
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unknown intermediate provider + no fallback apiBase available → warns twice, skips Tier 0, proceeds to Tier 1', async () => {
    // Build a cli-only implementer config (no apiBase at all) so the fallback
    // path has nothing to fall back to.
    const cliOnlyConfig = {
      version: 2 as const,
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
      implementer: { kind: 'cli' as const, tool: 'aider' as const, model: 'gpt-4' },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        autoApproveSpec: false,
        autoApprovePlan: false,
        maxRetries: 1,
        commitStrategy: 'none' as const,
        persistTranscript: true,
        compactionFormat: 'auto' as const,
        mode: 'standard' as const,
      },
      escalation: {
        intermediateProvider: 'totally-bogus-provider',
        intermediateModel: 'whatever',
        enabled: true,
      },
    };

    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'fail',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'hint',
        code: null,
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: cliOnlyConfig,
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
      task,
      initialError: 'error',
      currentState: state,
    });

    const warnings = busEvents.filter((e) => e.type === 'warning');
    expect(
      warnings.some(
        (e) => e.type === 'warning' && e.message.includes('Unknown intermediate provider'),
      ),
    ).toBe(true);
    expect(
      warnings.some((e) => e.type === 'warning' && e.message.includes('no API base URL available')),
    ).toBe(true);

    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('intermediate retry succeeds via fetch stub → completed with method=escalated-intermediate and tokens in implementer category', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask({ id: 'T001', file: 'src/intermediate-success.ts', action: 'create' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };

    // Intermediate provider returns real OpenAI-compatible SSE with extractable code.
    const code = '```typescript\nexport const fixed = true;\n```';
    fetchMock.mockResolvedValue(
      makeOpenAiSseResponse([
        { content: code },
        { usage: { prompt_tokens: 400, completion_tokens: 200 } },
      ]),
    );

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'fail',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const planner = makePlanner();

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1, commitStrategy: 'none' },
          escalation: {
            intermediateProvider: 'openrouter',
            intermediateModel: 'x-ai/grok-4-fast',
            enabled: true,
          },
        }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-intermediate');

    const escalateTier0 = busEvents.find((e) => e.type === 'escalate' && e.tier === 0);
    expect(escalateTier0).toBeDefined();
    expect(escalateTier0).toMatchObject({ type: 'escalate', tier: 0, tool: 'openrouter' });

    // Tier 0 succeeded, so Tier 1 never fires.
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeUndefined();

    expect(finalState.tokenUsage.implementerInput).toBeGreaterThanOrEqual(400);
    expect(finalState.tokenUsage.escalationInput).toBe(0);

    expect(fetchMock).toHaveBeenCalled();
  });

  it('intermediate retry fails via fetch rejection → falls through to Tier 1', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    fetchMock.mockRejectedValue(new Error('Connection timeout'));

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'fail',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'hint',
        code: null,
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1, commitStrategy: 'none' },
          escalation: {
            intermediateProvider: 'openrouter',
            intermediateModel: 'x-ai/grok-4-fast',
            enabled: true,
          },
        }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
      task,
      initialError: 'error',
      currentState: state,
    });

    // Tier 0 fires, fails, Tier 1 runs.
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 0)).toBeDefined();
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
  }, 20_000);
});
