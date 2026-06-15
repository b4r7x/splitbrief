import { vi } from 'vitest';
import type { ValidationResult } from '../../src/engine/orchestrator/validation-result.js';
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
import { createValidator } from '../../src/engine/orchestrator/validation.js';
import { defaultContext, makeNoValidationConfig } from './factories/config.js';

export const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'standard',
} as const;

export const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

export function makeWctx(
  overrides: Partial<WorkflowContext> & { projectDir: string; sessionId: string },
): WorkflowContext {
  return {
    config: makeNoValidationConfig(),
    callbacks: makeCallbacks().callbacks,
    bus: createEventBus(),
    context: { ...defaultContext, dir: overrides.projectDir },
    planner: makePlanner(),
    implementer: makeImplementer(),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
    ...overrides,
  };
}

export function makeCallbacks(overrides?: Partial<OrchestratorCallbacks>): {
  callbacks: OrchestratorCallbacks;
} {
  return {
    callbacks: {
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
      onCostApprovalNeeded: vi.fn().mockResolvedValue(true),
      onComplete: vi.fn(),
      ...overrides,
    },
  };
}

export function makePlanner(overrides?: Partial<Planner>): Planner {
  return {
    plan: vi.fn().mockResolvedValue({
      spec: '# Spec',
      plan: '# Plan',
      tasks: [makeTask()],
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    quickPlan: vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [makeTask()],
      usage: { inputTokens: 50, outputTokens: 25 },
    }),
    regenerate: vi.fn().mockResolvedValue({ text: 'regenerated', usage: null }),
    escalateHint: vi
      .fn()
      .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    escalateFull: vi
      .fn()
      .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0'),
    review: vi.fn().mockResolvedValue({ text: '', usage: null }),
    summarize: vi.fn().mockResolvedValue({ text: '', usage: null }),
    capabilities: {
      supportsConversationalPlanning: false,
      supportsHintEscalation: true,
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

export const passingResults: ValidationResult[] = [
  { passed: true, stage: 'typecheck' },
  { passed: true, stage: 'lint' },
  { passed: true, stage: 'test' },
];

export const failingResults: ValidationResult[] = [
  { passed: false, stage: 'typecheck', error: 'TS error' },
];

export function makeBusRecorder(): { bus: EventBus; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  return { bus, events };
}
