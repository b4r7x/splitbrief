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
import { passingReviewVerdict, planFromTasks, typedCallPlanAndReview } from './typed-planner.js';
import { loadState } from '../../src/core/state/persistence.js';
import type { SessionRef } from '../../src/core/types/session-ref.js';

export const TEST_METADATA = {
  planner: { tool: 'claude-code' },
  implementer: { tool: 'ollama' },
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
  });
}

export function makeCheckoutIsolation(opts: {
  projectDir: string;
  sessionId: string;
}): RunIsolation {
  return createRunIsolation({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    strategy: 'none',
    onFallback: () => {},
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

const wctxIsolations = new Set<RunIsolation>();

/**
 * Disposes the isolations `makeWctx` made. A failed attempt queues its revert without awaiting it,
 * so a test awaits this before it deletes the project, or that revert still runs git there.
 */
export async function disposeWctxIsolations(): Promise<void> {
  const isolations = [...wctxIsolations];
  wctxIsolations.clear();
  await Promise.all(isolations.map((isolation) => isolation.dispose()));
}

export function makeWctx(
  overrides: Partial<WorkflowContext> & { projectDir: string; sessionId: string },
): WorkflowContext {
  const planner = overrides.planner ?? makePlanner();
  let isolation = overrides.isolation;
  if (isolation === undefined) {
    isolation = makeCheckoutIsolation({
      projectDir: overrides.projectDir,
      sessionId: overrides.sessionId,
    });
    wctxIsolations.add(isolation);
  }
  return {
    config: makeNoValidationConfig(),
    callbacks: makeCallbacks().callbacks,
    bus: createEventBus(),
    context: { ...defaultContext, dir: overrides.projectDir },
    isolation,
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
  const task = makeTask();
  const usage = { inputTokens: 100, outputTokens: 50 };
  return {
    escalateFull: vi
      .fn()
      .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0'),
    review: vi.fn().mockResolvedValue({ text: '### Verdict\npass\n', usage: null }),
    summarize: vi.fn().mockResolvedValue({ text: '', usage: null }),
    // The reviewer mock answers `review_answer` with a passing verdict built from the
    // prompt's own `Task ids:` / `Criterion ids:` lines; the planner mock plans the task.
    typedCall: typedCallPlanAndReview(
      () => planFromTasks([task]),
      (prompt) => passingReviewVerdict(prompt),
      { plan: usage, review: usage },
    ),
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
