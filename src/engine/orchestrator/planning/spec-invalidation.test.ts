import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { makePassingTask } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  ANALYZE_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { ensureSessionDir, readSpecFileOrEmpty } from '../../../core/paths-io.js';
import type { ApproveLevel, WorkflowMode } from '../../../core/schemas/enums.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { Planner, PlannerDocumentCall, RunPhaseInput } from '../../planners/types.js';
import { invalidateFrom } from './invalidate.js';
import { runRewindPlanning } from './rewind.js';
import { runPlanningSteps } from './steps.js';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const SPEC_A = '# Spec\n\n- requirement A\n';
const SPEC_B = '# Spec\n\n- requirement B\n';
const CONSTITUTION = '# Constitution\n\n- Ship one slice at a time.\n';
const PASSING_VERDICT = '```json\n{"passed":true,"violations":[]}\n```';
const BLOCKING_VERDICT =
  '```json\n{"passed":false,"violations":[{"principle":"one-slice","reason":"too broad","severity":"hard"}]}\n```';
const FAILED_VERDICT_JSON =
  '{"passed":false,"violations":[{"principle":"one-slice","reason":"too broad","severity":"hard"}]}';

function setupProject(): { projectDir: string; sessionId: string; dir: string } {
  const projectDir = createTempDir('spec-invalidation');
  dirs.push(projectDir);
  const sessionId = 'sess-spec-invalidation';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId, dir: sessionDir(projectDir, sessionId) };
}

function seedConstitution(projectDir: string): void {
  mkdirSync(join(projectDir, '.specify', 'memory'), { recursive: true });
  writeFileSync(join(projectDir, '.specify', 'memory', 'constitution.md'), CONSTITUTION, 'utf8');
}

function seed(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text, 'utf8');
  }
}

function recordingPlanner(opts?: {
  specText?: string;
  review?: Planner['review'];
  regenerate?: Planner['regenerate'];
}): { planner: Planner; calls: PlannerDocumentCall[] } {
  const calls: PlannerDocumentCall[] = [];
  const planner = makePlanner({
    runPhase: vi.fn(async ({ call }: RunPhaseInput) => {
      calls.push(call);
      return makePhaseCallResult({
        call,
        ...(opts?.specText !== undefined && call === 'spec' ? { text: opts.specText } : {}),
        ...(call === 'tasks' ? { tasks: [makePassingTask()] } : {}),
      });
    }),
    ...(opts?.review ? { review: opts.review } : {}),
    ...(opts?.regenerate ? { regenerate: opts.regenerate } : {}),
  });
  return { planner, calls };
}

function stateFor(mode: WorkflowMode, overrides: Partial<WorkflowState> = {}): WorkflowState {
  return { ...transition(createInitialState('feat'), { type: 'START' }), mode, ...overrides };
}

async function runSteps(opts: {
  mode: WorkflowMode;
  planner: Planner;
  project: { projectDir: string; sessionId: string };
  state: WorkflowState;
  approveLevel?: ApproveLevel;
  onApprovalNeeded?: OrchestratorCallbacks['onApprovalNeeded'];
}): Promise<ReturnType<typeof runPlanningSteps>> {
  const { bus } = makeBusRecorder();
  return runPlanningSteps({
    wctx: {
      projectDir: opts.project.projectDir,
      sessionId: opts.project.sessionId,
      config: makeConfig({ workflow: { mode: opts.mode, approve: opts.approveLevel ?? 'none' } }),
      callbacks: makeCallbacks(
        opts.onApprovalNeeded ? { onApprovalNeeded: opts.onApprovalNeeded } : undefined,
      ).callbacks,
      bus,
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
    },
    planner: opts.planner,
    state: opts.state,
    feature: 'feat',
    ...(opts.approveLevel !== undefined ? { approveLevel: opts.approveLevel } : {}),
  });
}

describe('invalidateFrom', () => {
  it('a revised spec drops exactly its dependents and keeps the revised spec and research', () => {
    const { projectDir, sessionId, dir } = setupProject();
    seed(dir, {
      [RESEARCH_FILE]: '# Research\n',
      [SPEC_FILE]: SPEC_B,
      [CLARIFICATIONS_FILE]: '# Clarifications\n',
      [CONSTITUTION_CHECK_FILE]: '{"passed":true,"violations":[]}',
      [PLAN_FILE]: '# Plan\n',
      [TASKS_FILE]: '# Task Briefs\n',
      [ANALYZE_FILE]: '{}',
    });

    const dropped = invalidateFrom({ projectDir, sessionId }, 'spec');

    expect(dropped).toEqual([
      CLARIFICATIONS_FILE,
      CONSTITUTION_CHECK_FILE,
      PLAN_FILE,
      TASKS_FILE,
      ANALYZE_FILE,
    ]);
    for (const artifact of dropped) {
      expect(existsSync(join(dir, artifact))).toBe(false);
    }
    expect(readSpecFileOrEmpty({ projectDir, sessionId }, SPEC_FILE)).toBe(SPEC_B);
    expect(existsSync(join(dir, RESEARCH_FILE))).toBe(true);
  });

  it('a revised plan drops the briefs and the analyze verdict', () => {
    const { projectDir, sessionId, dir } = setupProject();
    seed(dir, { [PLAN_FILE]: '# Plan\n', [TASKS_FILE]: '# Task Briefs\n', [ANALYZE_FILE]: '{}' });

    const dropped = invalidateFrom({ projectDir, sessionId }, 'plan');

    expect(dropped).toEqual([TASKS_FILE, ANALYZE_FILE]);
    expect(existsSync(join(dir, PLAN_FILE))).toBe(true);
  });
});

describe('a spec change reruns the dependent constitution step', () => {
  it('an approval that edits the spec reruns constitution on the new contents and a blocking verdict stops before plan and tasks', async () => {
    const project = setupProject();
    seedConstitution(project.projectDir);
    const review = vi
      .fn()
      .mockResolvedValueOnce({ text: PASSING_VERDICT, usage: null })
      .mockResolvedValueOnce({ text: BLOCKING_VERDICT, usage: null });
    const { planner, calls } = recordingPlanner({ review, specText: SPEC_A });
    const onApprovalNeeded = vi.fn(async () => {
      writeFileSync(join(project.dir, SPEC_FILE), SPEC_B, 'utf8');
      return { approved: true as const };
    });

    const result = await runSteps({
      mode: 'speckit',
      planner,
      project,
      state: stateFor('speckit'),
      approveLevel: 'spec',
      onApprovalNeeded,
    });

    expect(review.mock.calls[0]?.[0]).toContain('requirement A');
    expect(review.mock.calls[1]?.[0]).toContain('requirement B');
    expect(calls).toEqual(['research', 'spec']);
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(result.state.phase).toBe('constitution-check');
  });

  it('a revise-spec rewind after a failed check rechecks the revised spec before plan and tasks', async () => {
    const project = setupProject();
    seedConstitution(project.projectDir);
    seed(project.dir, {
      [RESEARCH_FILE]: '# Research\n',
      [SPEC_FILE]: SPEC_A,
      [CLARIFICATIONS_FILE]: '# Clarifications\n',
      [CONSTITUTION_CHECK_FILE]: FAILED_VERDICT_JSON,
      [PLAN_FILE]: '# Plan\n',
      [TASKS_FILE]: '# Task Briefs\n',
      [ANALYZE_FILE]: '{}',
    });
    const review = vi.fn().mockResolvedValue({ text: PASSING_VERDICT, usage: null });
    const { planner, calls } = recordingPlanner({
      review,
      regenerate: vi.fn().mockResolvedValue({ text: SPEC_B, usage: null }),
    });
    const state = transition(stateFor('speckit', { phase: 'constitution-check' }), {
      type: 'REWIND_TO_SPEC',
      comment: 'requirement B instead',
    });

    const result = await runRewindPlanning(
      {
        wctx: {
          projectDir: project.projectDir,
          sessionId: project.sessionId,
          config: makeConfig({ workflow: { mode: 'speckit', approve: 'none' } }),
          callbacks: makeCallbacks().callbacks,
          bus: makeBusRecorder().bus,
          metadata: TEST_METADATA,
          sinks: TEST_SINKS,
        },
        planner,
        state,
        feature: 'feat',
        approveLevel: 'none',
      },
      { target: 'spec', comment: 'requirement B instead' },
    );

    expect(planner.regenerate).toHaveBeenCalledTimes(1);
    const spec = readSpecFileOrEmpty(
      { projectDir: project.projectDir, sessionId: project.sessionId },
      SPEC_FILE,
    );
    expect(spec).toContain('requirement B');
    expect(spec).not.toContain('requirement A');
    expect(review.mock.calls[0]?.[0]).toContain('requirement B');
    const verdict = JSON.parse(readFileSync(join(project.dir, CONSTITUTION_CHECK_FILE), 'utf8'));
    expect(verdict).toMatchObject({ passed: true });
    expect(calls).toEqual(['plan', 'tasks']);
    expect(result.disposition).toBe('tasks-ready');
  });

  it('a standard gate revise recompiles plan and briefs only — the speckit artifacts it now drops earn no calls', async () => {
    const project = setupProject();
    seed(project.dir, {
      [RESEARCH_FILE]: '# Research\n',
      [SPEC_FILE]: SPEC_A,
      [CLARIFICATIONS_FILE]: '# Clarifications\n',
      [CONSTITUTION_CHECK_FILE]: '{"passed":true,"violations":[]}',
      [PLAN_FILE]: '# Plan\n',
      [TASKS_FILE]: '# Task Briefs\n',
      [ANALYZE_FILE]: '{}',
    });
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'tighten the scope' })
      .mockResolvedValue({ approved: true });
    const { planner, calls } = recordingPlanner();

    const result = await runSteps({
      mode: 'standard',
      planner,
      project,
      state: stateFor('standard', { phase: 'reviewing-spec' }),
      approveLevel: 'spec',
      onApprovalNeeded,
    });

    expect(calls).toEqual(['plan', 'tasks']);
    expect(planner.review).not.toHaveBeenCalled();
    for (const file of [CLARIFICATIONS_FILE, CONSTITUTION_CHECK_FILE, ANALYZE_FILE]) {
      expect(existsSync(join(project.dir, file))).toBe(false);
    }
    expect(result.disposition).toBe('tasks-ready');
  });

  it('quick still spends exactly the one tasks call', async () => {
    const project = setupProject();
    const { planner, calls } = recordingPlanner();

    const result = await runSteps({
      mode: 'quick',
      planner,
      project,
      state: stateFor('quick', { phase: 'idle' }),
    });

    expect(calls).toEqual(['tasks']);
    expect(result.disposition).toBe('tasks-ready');
  });
});
