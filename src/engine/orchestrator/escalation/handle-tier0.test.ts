import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { handleRetryAndEscalation } from './handle.js';

// Hint/full escalation tiers each run a full recursive createStagedProject copy;
// under parallel full-suite load that staged-copy IO can push these cases past
// the 10s default, so widen the timeout for this file (cases pass in ~8-25s
// in isolation).
vi.setConfig({ testTimeout: 60_000 });

let dirs: string[] = [];
let savedOpenRouterKey: string | undefined;

beforeEach(() => {
  savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
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
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
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
      wctx: makeWctx({
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
        planner,
        callbacks,
        implementer,
        bus,
      }),
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
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: cliOnlyConfig,
        planner,
        callbacks,
        implementer,
        bus,
      }),
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

  it('intermediate retry succeeds via fetch stub → result carries the intermediate provider/model identity, tokens in implementer category', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
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
      wctx: makeWctx({
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
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-intermediate');
    // The intermediate tier is a paid call to a separately configured provider/model;
    // its identity must travel on the result so booking/pricing never default to the
    // primary implementer (regression for F-418).
    if (result.completed) {
      expect(result.tool).toBe('openrouter');
      expect(result.model).toBe('x-ai/grok-4-fast');
    }

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
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
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
      wctx: makeWctx({
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
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'error',
      currentState: state,
    });

    // Tier 0 fires, fails, Tier 1 runs.
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 0)).toBeDefined();
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
  });

  it('local retries succeed on the second attempt without escalating when maxRetries is 3', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const retry = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'fail-1',
        usage: { inputTokens: 5, outputTokens: 5 },
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'fixed',
        usage: { inputTokens: 20, outputTokens: 10 },
      });
    const implementer = makeImplementer({ retry });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 3, commitStrategy: 'none' } }),
        planner: makePlanner(),
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type err',
      currentState: makeValidatingState(),
    });

    const retryAttempts = busEvents
      .filter((event) => event.type === 'task_retry')
      .map((event) => (event.type === 'task_retry' ? event.attempt : -1));
    expect(retryAttempts).toEqual([1, 2]);
    expect(result).toEqual({ completed: true, method: 'local', attempts: 2 });
    expect(busEvents.filter((event) => event.type === 'escalate')).toEqual([]);
  });

  it('exhausts configured local retries then escalates tier 1 when every retry fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'persistent',
        usage: { inputTokens: 5, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'try X',
        code: null,
        usage: { inputTokens: 40, outputTokens: 20 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 3, commitStrategy: 'none' } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type err',
      currentState: makeValidatingState(),
    });

    const retryAttempts = busEvents
      .filter((event) => event.type === 'task_retry')
      .map((event) => (event.type === 'task_retry' ? event.attempt : -1));
    expect(retryAttempts).toEqual([1, 2, 3]);
    expect(busEvents.find((event) => event.type === 'escalate' && event.tier === 1)).toBeDefined();
  });

  it('emits ordered tier-1 and tier-2 escalate events and a failed terminal result when all tiers fail', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    let state = createInitialState('feat');
    state = transition(state, { type: 'START' });
    state = transition(state, { type: 'RESEARCH_DONE' });
    state = transition(state, { type: 'SPEC_DONE' });
    state = transition(state, { type: 'APPROVE_SPEC' });
    state = transition(state, { type: 'PLAN_DONE', tasks: [task] });
    state = transition(state, { type: 'BRIEFS_READY', tasks: [task] });
    state = transition(state, { type: 'APPROVE_BRIEFS' });
    state = transition(state, { type: 'TASK_SENT' });

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'hint',
        code: null,
        usage: { inputTokens: 30, outputTokens: 10 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 2, commitStrategy: 'none' } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    const retryAttempts = busEvents
      .filter((event) => event.type === 'task_retry')
      .map((event) => (event.type === 'task_retry' ? event.attempt : -1));
    const escalateTiers = busEvents
      .filter((event) => event.type === 'escalate')
      .map((event) => (event.type === 'escalate' ? event.tier : -1));

    expect(retryAttempts).toEqual([1, 2]);
    expect(escalateTiers).toEqual([1, 2]);
    expect(result).toEqual({ completed: false, method: 'failed', attempts: expect.any(Number) });
    expect(result.completed).toBe(false);
    expect(result.method).toBe('failed');
  });
});
