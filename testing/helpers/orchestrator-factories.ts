import { vi } from 'vitest';
import type { ValidationResult } from '../../src/core/types/summary.js';
import type { OrchestratorCallbacks } from '../../src/engine/orchestrator/types.js';
import type { Planner } from '../../src/engine/planners/types.js';
import type { Implementer } from '../../src/engine/implementers/types.js';
import { makeTask } from './factories/task.js';
import { createEventBus } from '../../src/engine/events/bus.js';
import type { EngineEvent, EventBus } from '../../src/engine/events/types.js';

export function makeCallbacks(overrides?: Partial<OrchestratorCallbacks>): { callbacks: OrchestratorCallbacks } {
  return {
    callbacks: {
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
      onExternalChanges: vi.fn().mockResolvedValue(false),
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
    escalateHint: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0'),
    review: vi.fn().mockResolvedValue({ text: '', usage: null }),
    capabilities: {
      supportsConversationalPlanning: false,
      supportsHintEscalation: true,
      supportsSessionResume: false,
    },
    ...overrides,
  };
}

export function makeImplementer(overrides?: Partial<Implementer>): Implementer {
  return {
    implement: vi.fn().mockResolvedValue({ success: true, output: 'code', usage: { inputTokens: 50, outputTokens: 25 } }),
    retry: vi.fn().mockResolvedValue({ success: true, output: 'fixed code', usage: { inputTokens: 50, outputTokens: 25 } }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0'),
    ...overrides,
  };
}

export const passingResults: ValidationResult[] = [
  { passed: true, stage: 'tsc' },
  { passed: true, stage: 'lint' },
  { passed: true, stage: 'test' },
];

export const failingResults: ValidationResult[] = [
  { passed: false, stage: 'tsc', error: 'TS error' },
];

export function makeBusRecorder(): { bus: EventBus; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  return { bus, events };
}
