import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, makePlanner, makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { handleRetryAndEscalation } from './escalation.js';
import type { WorkflowSinks } from '../types.js';
import { createValidator } from '../validation.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };

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
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks: [task] });
  state = transition(state, { type: 'APPROVE_PLAN' });
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
        projectDir, sessionId, config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'type error', currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('local');
    expect(implementer.retry).toHaveBeenCalled();
  });

  it('all local retries fail → hint retry also fails → result not completed', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks, events } = makeCallbacks();
    const task = makeTask();
    const state = makeValidatingState();

    // Both local retry attempts AND the hint-tier retry fail: no success anywhere.
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken', usage: { inputTokens: 10, outputTokens: 5 } }),
    });

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'use x', code: null, usage: { inputTokens: 50, outputTokens: 25 } }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'error', currentState: state,
    });

    // Local retries exhausted → hint called → full called → all failed.
    expect(result.completed).toBe(false);
    expect(planner.escalateHint).toHaveBeenCalled();
    expect(planner.escalateFull).toHaveBeenCalled();
    const escalateTier2 = events.find((e) => e.type === 'escalate' && e.tier === 2);
    expect(escalateTier2).toBeDefined();
  });

  it('hint-assisted retry succeeds → completed with method=escalated-hint', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks, events } = makeCallbacks();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn()
        // Local retry fails (attempt 1).
        .mockResolvedValueOnce({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } })
        // Hint-assisted retry succeeds.
        .mockResolvedValueOnce({ success: true, output: 'fixed', usage: { inputTokens: 20, outputTokens: 10 } }),
    });

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'try adding import', code: null, usage: { inputTokens: 100, outputTokens: 50 } }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'error', currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-hint');
    expect(events.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
  });

  it('Tier 2 full escalation: planner.escalateFull succeeds → completed with method=escalated-full', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks, events } = makeCallbacks();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: { inputTokens: 50, outputTokens: 25 } }),
      escalateFull: vi.fn().mockResolvedValue({ success: true, output: 'full code', code: 'code', usage: { inputTokens: 200, outputTokens: 100 } }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'error', currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-full');
    expect(events.find((e) => e.type === 'escalate' && e.tier === 2)).toBeDefined();
  });

  it('full escalation fails → task failed, discardTaskChanges performed on real git repo', async () => {
    const { projectDir, sessionId } = setupProject();
    // Create a dirty file so discardTaskChanges has something to clean.
    writeFileSync(join(projectDir, 'task-file.ts'), 'pending content');
    const task = makeTask({ file: 'task-file.ts', action: 'create' });
    const state = makeValidatingState();
    // Update task list with the file-matching task so discardTaskChanges finds a real path.
    const stateWithTask: WorkflowState = {
      ...state,
      tasks: [task],
    };

    const { callbacks } = makeCallbacks();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'error', currentState: stateWithTask,
    });

    expect(result.completed).toBe(false);
    expect(result.method).toBe('failed');
    expect(finalState.phase).toBeDefined();
  });
});

function openAiSseChunks(parts: Array<{ content?: string; usage?: { prompt_tokens: number; completion_tokens: number } }>): string {
  const lines: string[] = [];
  for (const p of parts) {
    const chunk: Record<string, unknown> = {
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'm',
      choices: [{ index: 0, delta: { content: p.content ?? '' }, finish_reason: null }],
    };
    if (p.usage) chunk.usage = p.usage;
    lines.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

function makeOpenAiSseResponse(parts: Parameters<typeof openAiSseChunks>[0]): Response {
  return new Response(openAiSseChunks(parts), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
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
    const { callbacks, events } = makeCallbacks();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: { inputTokens: 50, outputTokens: 25 } }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1, commitStrategy: 'none' } }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'error', currentState: state,
    });

    expect(events.find((e) => e.type === 'escalate' && e.tier === 0)).toBeUndefined();
    expect(events.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escalation.enabled = false → skips Tier 0, proceeds to Tier 1', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks, events } = makeCallbacks();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: { inputTokens: 50, outputTokens: 25 } }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1, commitStrategy: 'none' },
          escalation: { intermediateProvider: 'openrouter', intermediateModel: 'x-ai/grok-4', enabled: false },
        }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'error', currentState: state,
    });

    expect(events.find((e) => e.type === 'escalate' && e.tier === 0)).toBeUndefined();
    expect(events.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
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
        autoApproveSpec: false, autoApprovePlan: false,
        maxRetries: 1, commitStrategy: 'none' as const,
        persistTranscript: true, mode: 'standard' as const,
      },
      escalation: { intermediateProvider: 'totally-bogus-provider', intermediateModel: 'whatever', enabled: true },
    };

    const { projectDir, sessionId } = setupProject();
    const { callbacks, events } = makeCallbacks();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: { inputTokens: 50, outputTokens: 25 } }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: cliOnlyConfig,
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'error', currentState: state,
    });

    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings.some((e) => (e as { message: string }).message.includes('Unknown intermediate provider'))).toBe(true);
    expect(warnings.some((e) => (e as { message: string }).message.includes('no API base URL available'))).toBe(true);

    expect(events.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('intermediate retry succeeds via fetch stub → completed with method=escalated-intermediate and tokens in implementer category', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks, events } = makeCallbacks();
    const task = makeTask({ id: 'T001', file: 'src/intermediate-success.ts', action: 'create' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };

    // Intermediate provider returns real OpenAI-compatible SSE with extractable code.
    const code = '```typescript\nexport const fixed = true;\n```';
    fetchMock.mockResolvedValue(makeOpenAiSseResponse([
      { content: code },
      { usage: { prompt_tokens: 400, completion_tokens: 200 } },
    ]));

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    const planner = makePlanner();

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1, commitStrategy: 'none' },
          escalation: { intermediateProvider: 'openrouter', intermediateModel: 'x-ai/grok-4-fast', enabled: true },
        }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'type error', currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-intermediate');

    const escalateTier0 = events.find((e) => e.type === 'escalate' && e.tier === 0);
    expect(escalateTier0).toBeDefined();
    expect(escalateTier0).toMatchObject({ tier: 0, tool: 'openrouter' });

    expect(planner.escalateHint).not.toHaveBeenCalled();

    expect(finalState.tokenUsage.implementerInput).toBeGreaterThanOrEqual(400);
    expect(finalState.tokenUsage.escalationInput).toBe(0);

    expect(fetchMock).toHaveBeenCalled();
  });

  it('intermediate retry fails via fetch rejection → falls through to Tier 1', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks, events } = makeCallbacks();
    const task = makeTask();
    const state = makeValidatingState();

    fetchMock.mockRejectedValue(new Error('Connection timeout'));

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: { inputTokens: 50, outputTokens: 25 } }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1, commitStrategy: 'none' },
          escalation: { intermediateProvider: 'openrouter', intermediateModel: 'x-ai/grok-4-fast', enabled: true },
        }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: TEST_METADATA, sinks: TEST_SINKS, validator: TEST_VALIDATOR,
      },
      task, initialError: 'error', currentState: state,
    });

    // Tier 0 fires, fails, Tier 1 runs.
    expect(events.find((e) => e.type === 'escalate' && e.tier === 0)).toBeDefined();
    expect(events.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
    expect(planner.escalateHint).toHaveBeenCalled();
  }, 20_000);
});
