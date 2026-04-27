import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeCallbacks, makePlanner, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir, SPEC_FILE, PLAN_FILE, TASKS_FILE, BRIEF_QUALITY_FILE } from '../../../core/paths.js';
import { runPlanningPhase } from './run.js';
import { extractJsonBlock } from './speckit.js';
import { formatTasks } from '../../spec/formatter.js';
import type { Planner, PlanResult } from '../../planners/types.js';
import type { OrchestratorCallbacks } from '../types.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'speckit' };

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

function setupProject(opts?: { withConstitution?: string }): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('speckit-test');
  dirs.push(projectDir);
  const sessionId = 'sess-speckit';
  ensureSessionDir(projectDir, sessionId);
  if (opts?.withConstitution !== undefined) {
    mkdirSync(join(projectDir, '.specify', 'memory'), { recursive: true });
    writeFileSync(join(projectDir, '.specify', 'memory', 'constitution.md'), opts.withConstitution, 'utf8');
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
    tasks: [makeTask({
      id: 'T001',
      scope: { inBounds: ['src/a.ts'], outOfBounds: ['other files'] },
      evidence: ['brief-quality.json recorded a passing gate'],
      typeDefs: 'type TaskA = { path: string }',
    })],
    usage: { inputTokens: 10, outputTokens: 5 },
    phases: [],
  };
}

function invalidPlanResult(): PlanResult {
  return {
    spec: SAMPLE_SPEC,
    plan: SAMPLE_PLAN,
    tasks: [makeTask({ id: 'T-BAD', tests: [], implementationSteps: [] })],
    usage: { inputTokens: 10, outputTokens: 5 },
    phases: [],
  };
}

function expectBriefQualityBlocked(result: Awaited<ReturnType<typeof runPlanningPhase>>, projectDir: string, sessionId: string, events: ReturnType<typeof makeBusRecorder>['events']) {
  expect(result.cancelled).toBe(true);
  expect(result.state.phase).not.toBe('implementing');
  const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
  expect(existsSync(reportPath)).toBe(true);
  const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
  expect(persisted.passed).toBe(false);
  expect(events.find(e => e.type === 'brief_quality_failed')).toBeDefined();
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
  const reviewFn = opts.reviewText ?? (() => '```json\n{"specTaskCoverage":1,"planTaskCoverage":1,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```');
  const planner = makePlanner({
    plan: vi.fn().mockResolvedValue(planResult()),
    review: vi.fn().mockImplementation(async (prompt: string) => ({ text: reviewFn(prompt), usage: null })),
    ...opts.plannerOverrides,
  });
  const { callbacks } = makeCallbacks(opts.callbacksOverride);
  const config = makeConfig({ workflow: { mode: 'speckit', autoApproveSpec: true, autoApprovePlan: true } });
  const { bus, events } = makeBusRecorder();
  const initial = createInitialState('add login');
  const state: WorkflowState = { ...initial, phase: 'idle' };
  const result = await runPlanningPhase({
    wctx: {
      projectDir, config, callbacks, metadata: TEST_METADATA, sessionId, bus,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    },
    planner,
    state,
    feature: 'add login',
  });
  return { result, projectDir, sessionId, events, planner };
}

describe('extractJsonBlock', () => {
  it('extracts a fenced ```json block', () => {
    const out = extractJsonBlock('preamble\n```json\n{"a":1}\n```\nafter');
    expect(out).toEqual({ a: 1 });
  });

  it('extracts the first balanced { ... } when no fence is present', () => {
    const out = extractJsonBlock('text {"a":2,"b":[1,2]} trailing');
    expect(out).toEqual({ a: 2, b: [1, 2] });
  });

  it('returns {} on malformed JSON', () => {
    expect(extractJsonBlock('not json at all')).toEqual({});
  });

  it('handles strings with embedded braces correctly', () => {
    const out = extractJsonBlock('{"msg":"a } b"}');
    expect(out).toEqual({ msg: 'a } b' });
  });
});

describe('runSpeckitPlanning', () => {
  it('runs through clarify → constitution-check → planning → analyze and ends in implementing', async () => {
    const { result } = await runSpeckit();
    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks).toHaveLength(1);
  });

  it('writes clarifications.md, constitution-check.json, and analyze.json artifacts', async () => {
    const { projectDir, sessionId } = await runSpeckit();
    const dir = sessionDir(projectDir, sessionId);
    expect(existsSync(join(dir, 'clarifications.md'))).toBe(true);
    expect(existsSync(join(dir, 'constitution-check.json'))).toBe(true);
    expect(existsSync(join(dir, 'analyze.json'))).toBe(true);
    const cc = JSON.parse(readFileSync(join(dir, 'constitution-check.json'), 'utf8'));
    expect(cc.passed).toBe(true);
    const an = JSON.parse(readFileSync(join(dir, 'analyze.json'), 'utf8'));
    expect(an.specTaskCoverage).toBe(1);
  });

  it('skips constitution check when no constitution.md exists (passes by default)', async () => {
    const { result, planner } = await runSpeckit();
    expect(result.cancelled).toBe(false);
    // Only the analyze prompt should hit planner.review; the constitution check is a no-op.
    const reviewMock = planner.review as ReturnType<typeof vi.fn>;
    expect(reviewMock).toHaveBeenCalledTimes(1);
    const promptArg = reviewMock.mock.calls[0]?.[0] as string;
    expect(promptArg).toMatch(/Analysis/i);
  });

  it('runs the constitution check when constitution.md exists', async () => {
    const { planner } = await runSpeckit({ withConstitution: '# Rules\nNo classes.' });
    const reviewMock = planner.review as ReturnType<typeof vi.fn>;
    expect(reviewMock).toHaveBeenCalledTimes(2);
    const firstPrompt = reviewMock.mock.calls[0]?.[0] as string;
    expect(firstPrompt).toMatch(/Constitution Check/);
  });

  it('aborts the workflow on a hard constitution violation', async () => {
    const failJson = '```json\n{"passed":false,"violations":[{"principle":"P1","reason":"bad","severity":"hard"}]}\n```';
    const { result, projectDir, sessionId } = await runSpeckit({
      withConstitution: '# Rules',
      reviewText: (p) => p.includes('Constitution Check') ? failJson : '{}',
    });
    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(result.tasks).toEqual([]);
    const cc = JSON.parse(readFileSync(join(sessionDir(projectDir, sessionId), 'constitution-check.json'), 'utf8'));
    expect(cc.passed).toBe(false);
  });

  it('emits a warning event when analyze coverage is below threshold', async () => {
    const lowCoverage = '```json\n{"specTaskCoverage":0.4,"planTaskCoverage":0.5,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```';
    const { events } = await runSpeckit({ reviewText: () => lowCoverage });
    const warnings = events.filter(e => e.type === 'warning');
    expect(warnings.some(w => 'message' in w && /coverage below/.test(w.message))).toBe(true);
  });

  it('passes through phases in the documented order', async () => {
    const { events } = await runSpeckit();
    const statusEvents = events.filter(e => e.type === 'planner_status');
    const phasesInOrder = statusEvents.map(e => 'phase' in e ? e.phase : null);
    expect(phasesInOrder).toContain('clarifying');
    expect(phasesInOrder).toContain('constitution-check');
    expect(phasesInOrder).toContain('analyzing');
    const idxClarify = phasesInOrder.indexOf('clarifying');
    const idxConst = phasesInOrder.indexOf('constitution-check');
    const idxAnalyze = phasesInOrder.indexOf('analyzing');
    expect(idxClarify).toBeLessThan(idxConst);
    expect(idxConst).toBeLessThan(idxAnalyze);
  });

  it('enters reviewing-briefs for invalid briefs; user rejection cancels the workflow', async () => {
    const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValue({ approved: false });
    const { result, projectDir, sessionId, events } = await runSpeckit({
      plannerOverrides: { plan: vi.fn().mockResolvedValue(invalidPlanResult()) },
      callbacksOverride: { onApprovalNeeded },
    });
    expectBriefQualityBlocked(result, projectDir, sessionId, events);
  });

  it('blocks invalid briefs even when user approves reviewing-briefs', async () => {
    let tasksPath = '';
    const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: true })
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
    expect(onApprovalNeeded).toHaveBeenCalledTimes(4);
  });
});
