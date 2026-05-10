import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeCallbacks, makePlanner, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { expectBriefQualityBlocked } from '#testing/helpers/assertions/brief-quality.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir, TASKS_FILE, SPEC_FILE, PLAN_FILE, RESEARCH_FILE } from '../../../core/paths.js';
import { runPlanningPhase } from './run.js';
import type { Planner, PlanResult } from '../../planners/types.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'instant' };

const SAMPLE_TASKS_MD = `---
id: T001
title: Rename foo to bar
action: modify
file: src/foo.ts
---

### Description
Rename the symbol.

### Tests
- passes tsc

### Implementation Steps
1. Rename the symbol in src/foo.ts.

### Scope
- In bounds: src/foo.ts
- Out of bounds: unrelated modules

### Evidence
- brief-quality.json shows the task brief is complete
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('instant-test');
  dirs.push(projectDir);
  const sessionId = 'sess-instant';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function instantPlanResult(overrides?: Partial<PlanResult>): PlanResult {
  return {
    spec: '',
    plan: '',
    tasks: [makeTask({
      id: 'T-INSTANT',
      scope: { inBounds: ['src/foo.ts'], outOfBounds: ['other files'] },
      evidence: ['brief-quality.json recorded a passing gate'],
      typeDefs: 'type RenameTask = { file: string }',
    })],
    usage: { inputTokens: 30, outputTokens: 15 },
    phases: [{ text: SAMPLE_TASKS_MD, filename: TASKS_FILE }],
    ...overrides,
  };
}

function invalidPlanResult(overrides?: Partial<PlanResult>): PlanResult {
  return {
    spec: '',
    plan: '',
    tasks: [makeTask({ id: 'T-BAD', tests: [], implementationSteps: [] })],
    usage: { inputTokens: 30, outputTokens: 15 },
    phases: [{ text: SAMPLE_TASKS_MD, filename: TASKS_FILE }],
    ...overrides,
  };
}

async function runInstant(plannerOverrides?: Partial<Planner>) {
  const { projectDir, sessionId } = setupProject();
  const planner = makePlanner({
    instantPlan: vi.fn().mockResolvedValue(instantPlanResult()),
    ...plannerOverrides,
  });
  const { callbacks } = makeCallbacks();
  const config = makeConfig({ workflow: { mode: 'instant' } });
  const { bus, events } = makeBusRecorder();
  const initial = createInitialState('rename foo to bar');
  const state: WorkflowState = { ...initial, phase: 'idle' };
  const result = await runPlanningPhase({
    wctx: {
      projectDir, config, callbacks, metadata: TEST_METADATA, sessionId, bus,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    },
    planner,
    state,
    feature: 'rename foo to bar',
  });
  return { result, projectDir, sessionId, events, planner };
}

describe('runInstantPlanning', () => {
  it('writes only tasks.md (no spec/plan/research)', async () => {
    const { projectDir, sessionId } = await runInstant();
    const dir = sessionDir(projectDir, sessionId);
    expect(existsSync(join(dir, TASKS_FILE))).toBe(true);
    expect(readFileSync(join(dir, TASKS_FILE), 'utf-8')).toContain('Rename foo to bar');
    expect(existsSync(join(dir, SPEC_FILE))).toBe(false);
    expect(existsSync(join(dir, PLAN_FILE))).toBe(false);
    expect(existsSync(join(dir, RESEARCH_FILE))).toBe(false);
  });

  it('dispatches START_INSTANT and lands in implementing phase', async () => {
    const { result } = await runInstant();
    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T-INSTANT');
  });

  it('publishes mode_resolved and instant_plan_received events', async () => {
    const { events } = await runInstant();
    const modeResolved = events.find(e => e.type === 'mode_resolved');
    const instantReceived = events.find(e => e.type === 'instant_plan_received');
    expect(modeResolved).toBeDefined();
    expect(modeResolved && 'mode' in modeResolved ? modeResolved.mode : null).toBe('instant');
    expect(instantReceived).toBeDefined();
    expect(instantReceived && 'taskCount' in instantReceived ? instantReceived.taskCount : 0).toBe(1);
  });

  it('reaches implementation without opening approval gates', async () => {
    const onApprovalNeeded = async () => {
      throw new Error('instant mode should not request artifact approval');
    };
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      instantPlan: vi.fn().mockResolvedValue(instantPlanResult()),
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const initial = createInitialState('feature');
    const result = await runPlanningPhase({
      wctx: {
        projectDir, config, callbacks, metadata: TEST_METADATA, sessionId, bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
  });

  it('falls back to quickPlan when instantPlan is not provided', async () => {
    const quickPlan = vi.fn().mockResolvedValue(instantPlanResult());
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({ quickPlan });
    delete (planner as Partial<Planner>).instantPlan;
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const initial = createInitialState('feature');
    const result = await runPlanningPhase({
      wctx: {
        projectDir, config, callbacks, metadata: TEST_METADATA, sessionId, bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });
    expect(result.cancelled).toBe(false);
  });

  it('cancels when planner returns zero tasks', async () => {
    const { result } = await runInstant({
      instantPlan: vi.fn().mockResolvedValue(instantPlanResult({ tasks: [], phases: [{ text: '# empty', filename: TASKS_FILE }] })),
    });
    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(result.tasks).toHaveLength(0);
  });

  it('emits a warning when approve level overrides instant default', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({ instantPlan: vi.fn().mockResolvedValue(instantPlanResult()) });
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'instant', approve: 'all' } });
    const { bus, events } = makeBusRecorder();
    const initial = createInitialState('feature');
    await runPlanningPhase({
      wctx: {
        projectDir, config, callbacks, metadata: TEST_METADATA, sessionId, bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });
    const warning = events.find(e => e.type === 'warning');
    expect(warning).toBeDefined();
    if (warning && 'message' in warning) {
      expect(warning.message).toContain('instant');
      expect(warning.message).toContain('all');
    }
  });

  it('blocks invalid briefs before implementing and writes the brief-quality report', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      instantPlan: vi.fn().mockResolvedValue(invalidPlanResult()),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const initial = createInitialState('feature');

    const result = await runPlanningPhase({
      wctx: {
        projectDir, config, callbacks, metadata: TEST_METADATA, sessionId, bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expectBriefQualityBlocked(result, projectDir, sessionId, events);
  });
});
