import { vi } from 'vitest';
import type {
  OrchestratorCallbacks,
  WorkflowContext,
  WorkflowSinks,
} from '../../src/engine/orchestrator/types.js';
import type { Planner } from '../../src/engine/planners/types.js';
import type { Implementer } from '../../src/engine/implementers/types.js';
import { makeTask } from './factories/task.js';
import { createEventBus } from '../../src/engine/events/bus.js';
import type { EngineEvent, EventBus } from '../../src/engine/events/types.js';
import { createValidator } from '../../src/engine/orchestrator/validation/run.js';
import { createRunIsolation } from '../../src/engine/orchestrator/isolation/create.js';
import type { RunIsolation } from '../../src/engine/orchestrator/isolation/types.js';
import { defaultContext, makeNoValidationConfig } from './factories/config.js';
import { typedCallFromTasks } from './typed-planner.js';
import { loadState } from '../../src/core/state/persistence.js';
import type { SessionRef } from '../../src/core/types/session-ref.js';

export const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'standard',
} as const;

export const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

export function makeCopyingIsolation(opts: {
  projectDir: string;
  sessionId: string;
}): RunIsolation {
  return createRunIsolation({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    strategy: 'staged-copy',
    onFallback: () => {},
    onRetained: () => {},
  });
}

export function makeWorktreeIsolation(opts: {
  projectDir: string;
  sessionId: string;
}): RunIsolation {
  return createRunIsolation({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    strategy: 'worktree',
    onFallback: () => {},
    onRetained: () => {},
  });
}

/** The context a run hands its task loop: the run workspace opened, code read and validated there. */
export async function openRunWorkspace(wctx: WorkflowContext): Promise<WorkflowContext> {
  const opened = await wctx.isolation.open({ config: wctx.config });
  return { ...wctx, workspaceDir: opened.projectDir };
}

/** The run workspace a run recorded in its state: where its code lives until Apply. */
export function runWorkspaceDir(ref: SessionRef): string {
  const path = loadState(ref)?.workspace?.path;
  if (path === undefined) throw new Error(`Run ${ref.sessionId} recorded no workspace.`);
  return path;
}

export function makeWctx(
  overrides: Partial<WorkflowContext> & { projectDir: string; sessionId: string },
): WorkflowContext {
  const planner = overrides.planner ?? makePlanner();
  return {
    config: makeNoValidationConfig(),
    callbacks: makeCallbacks().callbacks,
    bus: createEventBus(),
    context: { ...defaultContext, dir: overrides.projectDir },
    isolation: makeCopyingIsolation({
      projectDir: overrides.projectDir,
      sessionId: overrides.sessionId,
    }),
    planner,
    reviewer: planner,
    implementer: makeImplementer(),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
    workspaceDir: overrides.projectDir,
    ...overrides,
  };
}

export function makeCallbacks(overrides?: Partial<OrchestratorCallbacks>): {
  callbacks: OrchestratorCallbacks;
} {
  return {
    callbacks: {
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
      onComplete: vi.fn(),
      ...overrides,
    },
  };
}

export function makePlanner(overrides?: Partial<Planner>): Planner {
  return {
    escalateFull: vi
      .fn()
      .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0'),
    review: vi.fn().mockResolvedValue({ text: '### Verdict\npass\n', usage: null }),
    summarize: vi.fn().mockResolvedValue({ text: '', usage: null }),
    typedCall: typedCallFromTasks([makeTask()], { inputTokens: 100, outputTokens: 50 }),
    capabilities: {
      supportsConversationalPlanning: false,
      supportsSessionResume: false,
      supportsEffort: false,
      supportsImages: false,
      supportsSelfSummarisation: false,
    },
    ...overrides,
  };
}

export function makeImplementer(overrides?: Partial<Implementer>): Implementer {
  return {
    implement: vi.fn().mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 50, outputTokens: 25 },
    }),
    retry: vi.fn().mockResolvedValue({
      success: true,
      output: 'fixed code',
      usage: { inputTokens: 50, outputTokens: 25 },
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0'),
    ...overrides,
  };
}

export function makeBusRecorder(): { bus: EventBus; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  return { bus, events };
}
