import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { makeBriefQualityFailureTask, REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import {
  ANALYZE_FILE,
  BRIEF_QUALITY_FILE,
  sessionDir,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
} from '../../../core/paths.js';
import { runPlanningPhase } from './run.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { runBriefQuality } from './brief-quality-run.js';
import { publishProducerGeneration } from './producer-publication.js';
import { createWorkflowRecoveryBinding } from '../run/recovery-binding.js';
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
const ANALYZE_RESULT =
  '```json\n{"specTaskCoverage":1,"planTaskCoverage":1,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```';

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
  // Pre-write the spec/plan artifacts so the planner mock doesn't have to.
  const dir = sessionDir(projectDir, sessionId);
  writeFileSync(join(dir, SPEC_FILE), SAMPLE_SPEC, 'utf8');
  writeFileSync(join(dir, PLAN_FILE), SAMPLE_PLAN, 'utf8');
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
    tasks: [makeTask({ id: 'T002', tests: [], implementationSteps: [] })],
    usage: { inputTokens: 10, outputTokens: 5 },
    phases: [],
  };
}

interface RunOpts {
  withConstitution?: string;
  reviewText?: (prompt: string) => string;
  plannerOverrides?: Partial<Planner>;
  callbacksOverride?: Partial<OrchestratorCallbacks>;
  state?: WorkflowState;
}

async function runSpeckit(opts: RunOpts = {}) {
  const { projectDir, sessionId } = setupProject(
    opts.withConstitution !== undefined ? { withConstitution: opts.withConstitution } : {},
  );
  const reviewFn = opts.reviewText ?? (() => ANALYZE_RESULT);
  const planner = makePlanner({
    plan: vi.fn().mockResolvedValue(planResult()),
    review: vi
      .fn()
      .mockImplementation(async (prompt: string) => ({ text: reviewFn(prompt), usage: null })),
    ...opts.plannerOverrides,
  });
  const { callbacks } = makeCallbacks(opts.callbacksOverride);
  const config = makeConfig({
    workflow: { mode: 'speckit', approve: 'none' },
  });
  const { bus, events } = makeBusRecorder();
  const initial = createInitialState('add login');
  const state: WorkflowState = opts.state ?? { ...initial, phase: 'idle' };
  const wctx = {
    projectDir,
    config,
    callbacks,
    metadata: TEST_METADATA,
    sessionId,
    bus,
    sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
  };
  const result = await runPlanningPhase({
    wctx,
    planner,
    state,
    feature: 'add login',
  });
  return { result, projectDir, sessionId, events, planner };
}

describe('runSpeckitPlanning', () => {
  it('publishes the compiled Brief and parks the committed authority', async () => {
    const { result, projectDir, sessionId, events } = await runSpeckit();
    expect(result.disposition).toBe('parked');
    if (result.disposition !== 'parked') return;
    expect(result.state.phase).toBe('analyzing');
    expect(result.state.tasks).toHaveLength(1);
    expect(result.state.generation ?? null).not.toBeNull();
    expect(result.state.permit ?? null).toBeNull();

    const dir = sessionDir(projectDir, sessionId);
    expect(existsSync(join(dir, 'clarifications.md'))).toBe(true);
    expect(existsSync(join(dir, 'constitution-check.json'))).toBe(true);
    expect(existsSync(join(dir, 'analyze.json'))).toBe(true);
    const cc = JSON.parse(readFileSync(join(dir, 'constitution-check.json'), 'utf8'));
    expect(cc.passed).toBe(true);
    const an = JSON.parse(readFileSync(join(dir, 'analyze.json'), 'utf8'));
    expect(an.specTaskCoverage).toBe(1);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
    expect(events.find((event) => event.type === 'plan_approved')).toBeUndefined();

    // The fixed projections are refreshed only after the generation commit.
    const tasksText = readFileSync(join(dir, TASKS_FILE), 'utf8');
    expect(tasksText).toContain('Create hello module');
    const quality = JSON.parse(readFileSync(join(dir, BRIEF_QUALITY_FILE), 'utf8'));
    expect(quality.passed).toBe(true);
    expect(
      events.some((event) => event.type === 'artifact_written' && event.filename === TASKS_FILE),
    ).toBe(true);
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.generation).toEqual(result.state.generation);
    expect(persisted?.permit ?? null).toBeNull();

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

  it('commits the speckit support artifacts with the published generation', async () => {
    const { result, projectDir, sessionId } = await runSpeckit();
    expect(result.disposition).toBe('parked');
    if (result.disposition !== 'parked') return;
    const generation = result.state.generation;
    if (generation === null || generation === undefined) {
      throw new Error('expected the committed generation');
    }

    const generationDir = join(
      sessionDir(projectDir, sessionId),
      'generations',
      generation.generationId,
    );
    expect(readdirSync(generationDir).sort()).toEqual([
      BRIEF_QUALITY_FILE,
      'manifest.json',
      PLAN_FILE,
      SPEC_FILE,
      TASKS_FILE,
    ]);
    expect(readFileSync(join(generationDir, SPEC_FILE), 'utf8')).toBe(SAMPLE_SPEC);
    expect(readFileSync(join(generationDir, PLAN_FILE), 'utf8')).toBe(SAMPLE_PLAN);
    const manifest = JSON.parse(readFileSync(join(generationDir, 'manifest.json'), 'utf8')) as {
      artifacts: { name: string; sha256: string }[];
    };
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual([
      SPEC_FILE,
      PLAN_FILE,
      TASKS_FILE,
      BRIEF_QUALITY_FILE,
    ]);
  });

  it('aborts the workflow on a hard constitution violation', async () => {
    const failJson =
      '```json\n{"passed":false,"violations":[{"principle":"P1","reason":"bad","severity":"hard"}]}\n```';
    const { result, projectDir, sessionId } = await runSpeckit({
      withConstitution: '# Rules',
      reviewText: (p) => (p.includes('Constitution Check') ? failJson : '{}'),
    });
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(result.state.tasks).toEqual([]);
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

  it('parks a compiler failure without dispatching the analyze review', async () => {
    const { result, projectDir, sessionId, planner } = await runSpeckit({
      plannerOverrides: {
        plan: vi.fn().mockRejectedValue(
          Object.assign(new Error('Batch 1 ended with terminal status failed'), {
            kind: 'task_compiler_provider_failed',
            data: { status: 'failed', batchOrdinal: 0 },
          }),
        ),
        review: vi.fn(),
      },
    });

    expect(result.disposition).toBe('parked');
    if (result.disposition !== 'parked') return;
    expect(result.projection.blocker).toMatchObject({
      kind: 'provider',
      code: 'task_compiler_provider_failed',
    });
    expect(planner.review).not.toHaveBeenCalled();
    expect(existsSync(join(sessionDir(projectDir, sessionId), ANALYZE_FILE))).toBe(false);
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

  it('does not perform a local zero-task repair before admission', async () => {
    const repairedTask = makeTask({
      title: 'Repaired Speckit brief',
      file: 'src/repaired.ts',
      scope: { inBounds: ['src/repaired.ts'], outOfBounds: ['unrelated files'] },
      evidence: ['the repaired brief has complete evidence'],
      typeDefs: 'type Repaired = { ok: true }',
    });
    const review = vi
      .fn<Planner['review']>()
      .mockResolvedValueOnce({ text: formatTasks([repairedTask]), usage: null })
      .mockResolvedValueOnce({ text: ANALYZE_RESULT, usage: null });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { result, projectDir, sessionId, events, planner } = await runSpeckit({
      plannerOverrides: {
        plan: vi.fn().mockResolvedValue({ ...planResult(), tasks: [] }),
        review,
      },
      callbacksOverride: { onApprovalNeeded },
    });

    expect(result.disposition).toBe('parked');
    if (result.disposition !== 'parked') return;
    expect(result.state.phase).toBe('analyzing');
    expect(result.state.tasks).toEqual([]);
    expect(result.state.generation ?? null).toBeNull();
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
    const blocked = events.find(
      (event) => event.type === 'warning' && event.code === 'brief_publication_blocked',
    );
    expect(blocked).toBeDefined();
    expect(existsSync(join(sessionDir(projectDir, sessionId), TASKS_FILE))).toBe(false);
    expect(
      events.some((event) => event.type === 'planner_status' && event.phase === 'analyzing'),
    ).toBe(true);
    expect(planner.review).toHaveBeenCalledTimes(1);
  });

  it('parks a quality-failing publication without any partial authority', async () => {
    const invalidTasks = invalidPlanResult().tasks;
    const review = vi.fn<Planner['review']>().mockResolvedValue({
      text: formatTasks(invalidTasks),
      usage: null,
    });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { result, projectDir, sessionId, events, planner } = await runSpeckit({
      plannerOverrides: {
        plan: vi.fn().mockResolvedValue(invalidPlanResult()),
        review,
      },
      callbacksOverride: { onApprovalNeeded },
    });

    expect(result.disposition).toBe('parked');
    if (result.disposition !== 'parked') return;
    expect(result.state.phase).toBe('analyzing');
    expect(result.state.tasks).toHaveLength(1);
    expect(result.state.generation ?? null).toBeNull();
    expect(result.state.permit ?? null).toBeNull();
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.generation ?? null).toBeNull();
    expect(persisted?.permit ?? null).toBeNull();
    expect(persisted?.briefRecovery ?? null).toBeNull();
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(
      events.some((event) => event.type === 'planner_status' && event.phase === 'analyzing'),
    ).toBe(true);
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(0);
    const blocked = events.find(
      (event) => event.type === 'warning' && event.code === 'brief_publication_blocked',
    );
    expect(blocked).toBeDefined();
    const dir = sessionDir(projectDir, sessionId);
    expect(existsSync(join(dir, ANALYZE_FILE))).toBe(true);
    expect(existsSync(join(dir, TASKS_FILE))).toBe(false);
    expect(existsSync(join(dir, BRIEF_QUALITY_FILE))).toBe(false);
    expect(
      events.some((event) => event.type === 'artifact_written' && event.filename === TASKS_FILE),
    ).toBe(false);
  });

  it('leaves the prior generation and projections untouched when publication fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const ref = { projectDir, sessionId };
    const seeded = publishProducerGeneration({
      ref,
      state: { ...createInitialState('seed'), phase: 'idle' },
      planResult: planResult(),
      bus: makeBusRecorder().bus,
      phase: 'idle',
      metadata: TEST_METADATA,
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const dir = sessionDir(projectDir, sessionId);
    const tasksBefore = readFileSync(join(dir, TASKS_FILE), 'utf8');
    const headBefore = readWorkflowStateHead(ref);
    if (headBefore === null) throw new Error('expected the seeded workflow head');
    expect(headBefore.state.generation?.generationId).toBe(seeded.identity.ref.generationId);

    const { result } = await runSpeckit({
      plannerOverrides: {
        plan: vi.fn().mockResolvedValue(invalidPlanResult()),
      },
      state: headBefore.state,
    });

    expect(result.disposition).toBe('parked');
    if (result.disposition !== 'parked') return;
    const headAfter = readWorkflowStateHead(ref);
    expect(headAfter?.state.generation?.generationId).toBe(seeded.identity.ref.generationId);
    expect(headAfter?.state.permit ?? null).toBeNull();
    expect(headAfter?.state.briefRecovery ?? null).toBeNull();
    expect(readFileSync(join(dir, TASKS_FILE), 'utf8')).toBe(tasksBefore);
  });

  it('consumes the shared automatic repair allowance at most once across replay', async () => {
    const { projectDir, sessionId } = setupProject();
    const ref = { projectDir, sessionId };
    const config = makeConfig({
      workflow: { mode: 'speckit', approve: 'none' },
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5.4',
      },
    });
    const state: WorkflowState = {
      ...createInitialState('add login'),
      phase: 'idle',
      stateFence: { token: 1, ownerId: 'recovery-test-owner' },
    };
    saveState(ref, state);
    const initialHead = readWorkflowStateHead(ref);
    if (initialHead === null) throw new Error('expected the initial workflow head');

    const review = vi
      .fn<Planner['review']>()
      .mockResolvedValueOnce({ text: ANALYZE_RESULT, usage: null })
      .mockResolvedValue({ text: REAL_TASKS_MD, usage: null });
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: SAMPLE_SPEC,
        plan: SAMPLE_PLAN,
        tasks: [makeBriefQualityFailureTask()],
        usage: { inputTokens: 10, outputTokens: 5 },
        phases: [],
      }),
      review,
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const wctx = makeWctx({
      projectDir,
      sessionId,
      config,
      callbacks,
      planner,
      metadata: TEST_METADATA,
      bus,
      modelCache: {
        getModelsDevCatalog: () => ({
          openai: {
            id: 'openai',
            models: {
              'gpt-5.4': {
                id: 'gpt-5.4',
                cost: { input: 2.5, output: 15 },
                limit: { context: 400_000 },
              },
            },
          },
        }),
        getProviderModels: () => null,
      },
    });
    let trackedState: WorkflowState = state;
    const authorityBase: Omit<StateAuthorityReceipt, 'stateRevision' | 'stateDigest'> = {
      kind: 'usable',
      sessionId,
      ownerId: 'recovery-test-owner',
      pid: process.pid,
      processStart: 'speckit-recovery-test-process',
      runId: 'speckit-recovery-test-run',
      acquisitionId: 'speckit-recovery-test-acquisition',
      fence: 1,
    };
    const binding = createWorkflowRecoveryBinding({
      wctx,
      getState: () => trackedState,
      setState: (next) => {
        trackedState = next;
      },
      getAuthority: () => {
        const head = readWorkflowStateHead(ref);
        if (head === null) {
          return {
            ...authorityBase,
            stateRevision: initialHead.state.stateRevision ?? 0,
            stateDigest: initialHead.digest,
          };
        }
        return {
          ...authorityBase,
          stateRevision: head.state.stateRevision ?? 0,
          stateDigest: head.digest,
        };
      },
    });

    const planning = await runPlanningPhase({
      wctx,
      planner,
      state,
      feature: 'add login',
      recovery: binding,
    });
    expect(planning.disposition).toBe('parked');
    if (planning.disposition !== 'parked') return;

    const quality = await runBriefQuality({
      tasks: [...planning.state.tasks],
      state: planning.state,
      planner,
      wctx,
      recovery: binding,
    });
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.projection.status).toBe('ready');

    const head = readWorkflowStateHead(ref);
    const recovery = head?.state.briefRecovery;
    expect(recovery?.status).toBe('ready');
    if (recovery === null || recovery === undefined || recovery.status !== 'ready') {
      throw new Error('expected a ready normal recovery record');
    }
    expect(recovery.automaticRepair.consumed).toBe(true);
    const attempts = Object.values(recovery.attempts ?? {});
    expect(attempts.filter((attempt) => attempt.kind === 'automatic')).toHaveLength(1);
    expect(review).toHaveBeenCalledTimes(2);

    const replayed = await binding.controller.enterBriefAdmission(
      binding.createAdmissionInput({
        state: planning.state,
        tasks: [...planning.state.tasks],
        projectDir,
        sessionId,
      }),
      binding.authority,
    );
    expect(replayed.kind).toBe('ready');
    expect(review).toHaveBeenCalledTimes(2);
    const headAfterReplay = readWorkflowStateHead(ref);
    const replayRecovery = headAfterReplay?.state.briefRecovery;
    if (
      replayRecovery === null ||
      replayRecovery === undefined ||
      replayRecovery.status !== 'ready'
    ) {
      throw new Error('expected a ready normal recovery record after replay');
    }
    const attemptsAfterReplay = Object.values(replayRecovery.attempts ?? {});
    expect(attemptsAfterReplay.filter((attempt) => attempt.kind === 'automatic')).toHaveLength(1);
  });
});
