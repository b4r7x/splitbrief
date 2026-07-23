import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { TaskId } from '../../../core/schemas/task.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { expectBriefQualityBlocked } from '#testing/helpers/assertions/brief-quality.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { ANALYZE_FILE, sessionDir, SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../../core/paths.js';
import { runPlanningPhase } from './run.js';
import { formatTasks } from '../../spec/formatter.js';
import type { Planner, PlanResult } from '../../planners/types.js';
import type { OrchestratorCallbacks } from '../types.js';

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'speckit',
} as const;

const SAMPLE_SPEC = '# Spec\n\n- requirement A\n';
const SAMPLE_PLAN = '# Plan\n\n1. step A\n';
const SAMPLE_TASKS_WITH_SECTIONS = `---
id: T001
title: do A
action: create
file: src/a.ts
---

### Description
Do A.

### Tests
- passes tsc

### Implementation Steps
1. Create src/a.ts.

### Scope
**In bounds:**
- src/a.ts

**Out of bounds:**
- unrelated files

### Evidence
- brief-quality.json records a passing gate
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(opts?: { withConstitution?: string }): {
  projectDir: string;
  sessionId: string;
} {
  const projectDir = createTempDir('speckit-test');
  dirs.push(projectDir);
  const sessionId = 'sess-speckit';
  ensureSessionDir(projectDir, sessionId);
  if (opts?.withConstitution !== undefined) {
    mkdirSync(join(projectDir, '.specify', 'memory'), { recursive: true });
    writeFileSync(
      join(projectDir, '.specify', 'memory', 'constitution.md'),
      opts.withConstitution,
      'utf8',
    );
  }
  // Pre-write the spec/plan/tasks artifacts so the planner mock doesn't have to.
  const dir = sessionDir(projectDir, sessionId);
  writeFileSync(join(dir, SPEC_FILE), SAMPLE_SPEC, 'utf8');
  writeFileSync(join(dir, PLAN_FILE), SAMPLE_PLAN, 'utf8');
  writeFileSync(join(dir, TASKS_FILE), SAMPLE_TASKS_WITH_SECTIONS, 'utf8');
  return { projectDir, sessionId };
}

function planResult(): PlanResult {
  return {
    spec: SAMPLE_SPEC,
    plan: SAMPLE_PLAN,
    tasks: [
      makeTask({
        id: 'T001',
        scope: { inBounds: ['src/a.ts'], outOfBounds: ['other files'] },
        evidence: ['brief-quality.json recorded a passing gate'],
        typeDefs: 'type TaskA = { path: string }',
      }),
    ],
    usage: { inputTokens: 10, outputTokens: 5 },
    phases: [],
  };
}

function invalidPlanResult(): PlanResult {
  return {
    spec: SAMPLE_SPEC,
    plan: SAMPLE_PLAN,
    tasks: [
      {
        ...makeTask(),
        id: 'T-BAD' as unknown as TaskId,
        tests: [],
        implementationSteps: [],
      },
    ],
    usage: { inputTokens: 10, outputTokens: 5 },
    phases: [],
  };
}

interface RunOpts {
  withConstitution?: string;
  reviewText?: (prompt: string) => string;
  plannerOverrides?: Partial<Planner>;
  callbacksOverride?: Partial<OrchestratorCallbacks>;
}

async function runSpeckit(opts: RunOpts = {}) {
  const { projectDir, sessionId } = setupProject(
    opts.withConstitution !== undefined ? { withConstitution: opts.withConstitution } : {},
  );
  const reviewFn =
    opts.reviewText ??
    (() =>
      '```json\n{"specTaskCoverage":1,"planTaskCoverage":1,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```');
  const planner = makePlanner({
    plan: vi.fn().mockResolvedValue(planResult()),
    review: vi
      .fn()
      .mockImplementation(async (prompt: string) => ({ text: reviewFn(prompt), usage: null })),
    ...opts.plannerOverrides,
  });
  const { callbacks } = makeCallbacks(opts.callbacksOverride);
  const config = makeConfig({
    workflow: { mode: 'speckit', autoApproveSpec: true, autoApprovePlan: true },
  });
  const { bus, events } = makeBusRecorder();
  const initial = createInitialState('add login');
  const state: WorkflowState = { ...initial, phase: 'idle' };
  const result = await runPlanningPhase({
    wctx: {
      projectDir,
      config,
      callbacks,
      metadata: TEST_METADATA,
      sessionId,
      bus,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    },
    planner,
    state,
    feature: 'add login',
  });
  return { result, projectDir, sessionId, events, planner };
}

describe('runSpeckitPlanning', () => {
  it('completes the successful Speckit flow end to end', async () => {
    const { result, projectDir, sessionId, events } = await runSpeckit();
    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks).toHaveLength(1);

    const dir = sessionDir(projectDir, sessionId);
    expect(existsSync(join(dir, 'clarifications.md'))).toBe(true);
    expect(existsSync(join(dir, 'constitution-check.json'))).toBe(true);
    expect(existsSync(join(dir, 'analyze.json'))).toBe(true);
    const cc = JSON.parse(readFileSync(join(dir, 'constitution-check.json'), 'utf8'));
    expect(cc.passed).toBe(true);
    const an = JSON.parse(readFileSync(join(dir, 'analyze.json'), 'utf8'));
    expect(an.specTaskCoverage).toBe(1);

    const statusEvents = events.filter((e) => e.type === 'planner_status');
    const phasesInOrder = statusEvents.map((e) => e.phase);
    const clarifying = phasesInOrder.indexOf('clarifying');
    const constitutionCheck = phasesInOrder.indexOf('constitution-check');
    const planning = phasesInOrder.indexOf('planning');
    const analyzing = phasesInOrder.indexOf('analyzing');
    expect(clarifying).toBeGreaterThanOrEqual(0);
    expect(constitutionCheck).toBeGreaterThan(clarifying);
    expect(planning).toBeGreaterThan(constitutionCheck);
    expect(analyzing).toBeGreaterThan(planning);

    const specifyingRunning = events.find(
      (e) => e.type === 'planner_status' && e.status === 'running' && e.phase === 'specifying',
    );
    expect(specifyingRunning).toBeDefined();
  });

  it('aborts the workflow on a hard constitution violation', async () => {
    const failJson =
      '```json\n{"passed":false,"violations":[{"principle":"P1","reason":"bad","severity":"hard"}]}\n```';
    const { result, projectDir, sessionId } = await runSpeckit({
      withConstitution: '# Rules',
      reviewText: (p) => (p.includes('Constitution Check') ? failJson : '{}'),
    });
    expect(result.cancelled).toBe(true);
    expect(result.tasks).toEqual([]);
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.phase).toBe('idle');
    expect(persisted?.tasks).toEqual([]);
    expect(existsSync(join(sessionDir(projectDir, sessionId), ANALYZE_FILE))).toBe(false);
    const cc = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), 'constitution-check.json'), 'utf8'),
    );
    expect(cc.passed).toBe(false);
  });

  it('emits a warning event when analyze coverage is below threshold', async () => {
    const lowCoverage =
      '```json\n{"specTaskCoverage":0.4,"planTaskCoverage":0.5,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```';
    const { events } = await runSpeckit({ reviewText: () => lowCoverage });
    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings.some((w) => 'message' in w && /coverage below/.test(w.message))).toBe(true);
  });

  it('records planner token usage from analyze review calls', async () => {
    const withoutReviewUsage = await runSpeckit();
    const withReviewUsage = await runSpeckit({
      plannerOverrides: {
        review: vi.fn().mockResolvedValue({
          text: '```json\n{"specTaskCoverage":1,"planTaskCoverage":1,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```',
          usage: { inputTokens: 7, outputTokens: 3 },
        }),
      },
    });

    expect(
      withReviewUsage.result.state.tokenUsage.plannerInput -
        withoutReviewUsage.result.state.tokenUsage.plannerInput,
    ).toBe(7);
    expect(
      withReviewUsage.result.state.tokenUsage.plannerOutput -
        withoutReviewUsage.result.state.tokenUsage.plannerOutput,
    ).toBe(3);
  });

  it('enters reviewing-briefs for invalid briefs; user rejection cancels the workflow', async () => {
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: false });
    const { result, projectDir, sessionId, events } = await runSpeckit({
      plannerOverrides: { plan: vi.fn().mockResolvedValue(invalidPlanResult()) },
      callbacksOverride: { onApprovalNeeded },
    });
    expectBriefQualityBlocked(result, projectDir, sessionId, events);
  });

  it('blocks invalid briefs even when user approves reviewing-briefs', async () => {
    let tasksPath = '';
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async (_type, filePath) => {
        tasksPath = filePath;
        writeFileSync(filePath, formatTasks(invalidPlanResult().tasks), 'utf8');
        return { approved: true };
      })
      .mockResolvedValue({ approved: false });
    const { result, projectDir, sessionId, events } = await runSpeckit({
      plannerOverrides: { plan: vi.fn().mockResolvedValue(invalidPlanResult()) },
      callbacksOverride: { onApprovalNeeded },
    });
    expectBriefQualityBlocked(result, projectDir, sessionId, events);
    expect(tasksPath.endsWith(TASKS_FILE)).toBe(true);
  });
});
