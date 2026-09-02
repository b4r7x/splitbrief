import { join } from 'node:path';
import { runFullPlanning, isCompilerFailureProjection } from './full.js';
import { transitionAndSave } from '../state-ops.js';
import { publishPlannerStatus, publishWarning } from '../events.js';
import {
  ANALYZE_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SPECIFY_CONSTITUTION_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { readFileOrEmpty, writeSecureFile } from '../../../lib/fs.js';
import { confinedReadFileOrEmpty } from '../../../lib/confined-fs.js';
import { readSpecFileOrEmpty } from '../../../core/paths-io.js';
import { buildConstitutionPrompt } from '../../spec/prompts/constitution.js';
import { buildAnalyzePrompt } from '../../spec/prompts/analyze.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';
import type {
  ConstitutionCheckResult,
  ConstitutionViolation,
} from '../../../core/schemas/constitution.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { AnalyzeResult } from '../../../core/schemas/analyze.js';
import { PhaseSchema } from '../../../core/schemas/enums.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { extractJsonBlock } from '../../../utils/extract-json-block.js';
import { clamp01 } from '../../../utils/math.js';
import { runPlannerReview } from '../planner-review.js';
import { withContinuationLoop } from '../continuation.js';
import { composeSteeredPrompt } from '../../spec/prompts/steered-prompt.js';
import { fallbackBriefRecoveryProjection } from './brief-quality-queue.js';
import { publishProducerGeneration } from './producer-publication.js';

const DEFAULT_MIN_COVERAGE = 0.9;

function parseConstitutionCheck(text: string): ConstitutionCheckResult {
  const obj = narrowRecord(extractJsonBlock(text));
  if (!obj) {
    return {
      passed: true,
      violations: [
        { principle: 'meta', reason: 'constitution check output malformed', severity: 'soft' },
      ],
    };
  }
  const passed = typeof obj.passed === 'boolean' ? obj.passed : true;
  const rawViolations = Array.isArray(obj.violations) ? obj.violations : [];
  const violations: ConstitutionViolation[] = [];
  for (const v of rawViolations) {
    const rec = narrowRecord(v);
    if (!rec) continue;
    const principle = typeof rec.principle === 'string' ? rec.principle : 'unknown';
    const reason = typeof rec.reason === 'string' ? rec.reason : '';
    const severity: 'hard' | 'soft' = rec.severity === 'hard' ? 'hard' : 'soft';
    violations.push({ principle, reason, severity });
  }
  return { passed, violations };
}

function parseAnalyze(text: string): AnalyzeResult {
  const fallback: AnalyzeResult = {
    specTaskCoverage: 0,
    planTaskCoverage: 0,
    orphanTasks: [],
    unaddressedSpecSections: [],
    warnings: ['analyze output malformed'],
  };
  const obj = narrowRecord(extractJsonBlock(text));
  if (!obj) return fallback;
  const num = (v: unknown, def: number): number => {
    if (typeof v !== 'number' || Number.isNaN(v)) return def;
    return clamp01(v);
  };
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    specTaskCoverage: num(obj.specTaskCoverage, 0),
    planTaskCoverage: num(obj.planTaskCoverage, 0),
    orphanTasks: strArr(obj.orphanTasks),
    unaddressedSpecSections: strArr(obj.unaddressedSpecSections),
    warnings: strArr(obj.warnings),
  };
}

async function readConstitution(projectDir: string): Promise<string> {
  return confinedReadFileOrEmpty(projectDir, SPECIFY_CONSTITUTION_FILE);
}

async function readArtifact(dir: string, file: string): Promise<string> {
  return readFileOrEmpty(join(dir, file));
}

function formatClarificationsPlaceholder(): string {
  return '# Clarifications\n\n_Inline clarifications collected during the spec phase are appended to spec.md. See spec.md for the answered questions._\n';
}

function readSpeckitConfig(opts: PlanningPhaseOptions): { minCoverage: number } {
  const min = opts.wctx.config.workflow.speckit?.minCoverage;
  return { minCoverage: typeof min === 'number' ? min : DEFAULT_MIN_COVERAGE };
}

export async function runSpeckitPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, bus } = wctx;
  const dir = sessionDir(projectDir, sessionId);
  let { state } = opts;

  const planResult = await runFullPlanning({
    ...opts,
    state,
    afterSpecReview: async ({ state: reviewedState, tasks: reviewedTasks }) => {
      const constitution = await runConstitutionGate({ ...opts, state: reviewedState });
      return { ...constitution, tasks: reviewedTasks };
    },
  });
  state = planResult.state;
  if (planResult.disposition === 'terminal') return planResult;
  if (planResult.disposition === 'parked' && isCompilerFailureProjection(planResult.projection)) {
    return planResult;
  }
  const tasks = planResult.disposition === 'ready-for-tasks' ? [...planResult.tasks] : state.tasks;

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'ANALYZE_START' });
  publishPlannerStatus(bus, state, 'running');

  const [researchText, specText, planText, tasksText] = await Promise.all([
    readArtifact(dir, RESEARCH_FILE),
    readArtifact(dir, SPEC_FILE),
    readArtifact(dir, PLAN_FILE),
    readArtifact(dir, TASKS_FILE),
  ]);
  const analyzePrompt = buildAnalyzePrompt({ spec: specText, plan: planText, tasks: tasksText });
  const analyzeLoop = await withContinuationLoop<{ state: WorkflowState; text: string }>({
    ctx: {
      projectDir,
      sessionId,
      callbacks: wctx.callbacks,
      bus,
      signal: wctx.signal,
      sinks: wctx.sinks,
    },
    state,
    onStateChange: (s) => {
      state = s;
    },
    body: ({ signal, continuationPrompt, steer }) =>
      runPlannerReview({
        planner,
        prompt: composeSteeredPrompt(continuationPrompt ?? analyzePrompt, steer),
        projectDir,
        sessionId,
        bus,
        state,
        signal,
      }),
  });
  state = analyzeLoop.value.state;
  const analysis = parseAnalyze(analyzeLoop.value.text);
  writeSecureFile(join(dir, ANALYZE_FILE), JSON.stringify(analysis, null, 2));

  const { minCoverage } = readSpeckitConfig(opts);
  if (analysis.specTaskCoverage < minCoverage || analysis.planTaskCoverage < minCoverage) {
    bus.publish({
      type: 'warning',
      ts: Date.now(),
      phase: state.phase,
      message: `analyze coverage below ${minCoverage}: spec=${analysis.specTaskCoverage}, plan=${analysis.planTaskCoverage}`,
    });
  }

  publishPlannerStatus(bus, state, 'done');

  // Without an owner binding the speckit producer publishes the compiled
  // candidate itself: the immutable generation install and the fenced parked
  // commit come first, and the fixed tasks.md / brief-quality.json projections
  // are refreshed only after that commit. A publication fault parks with the
  // previous authority untouched. With an owner binding the producer parks
  // pre-admission so the shared controller accepts at most one automatic
  // repair operation against the durable allowance.
  if (opts.recovery === undefined) {
    const published = publishProducerGeneration({
      ref: { projectDir, sessionId },
      state,
      planResult: { tasks, research: researchText, spec: specText, plan: planText },
      bus,
      phase: state.phase,
      metadata: wctx.metadata,
    });
    if (!published.ok) {
      publishWarning({
        bus,
        phase: state.phase,
        message: `speckit mode: the Task Brief could not be published; ${published.message}`,
        safety: { category: 'planning', code: 'brief_publication_blocked', transcriptSafe: true },
      });
      return parkedSpeckitResult(opts, state, tasks, planResult);
    }
    state = {
      ...state,
      phase: PhaseSchema.parse(published.committed.recovery.phase),
      briefRecovery: published.committed.recovery.briefRecovery,
      authorityRevision: published.committed.authorityRevision,
      generation: published.committed.generation,
      permit: published.committed.permit,
    };
  }

  return parkedSpeckitResult(opts, state, tasks, planResult);
}

function parkedSpeckitResult(
  opts: PlanningPhaseOptions,
  state: WorkflowState,
  tasks: Task[],
  planResult: PlanningPhaseResult,
): PlanningPhaseResult {
  return {
    disposition: 'parked',
    state: { ...state, tasks },
    projection:
      planResult.disposition === 'parked'
        ? planResult.projection
        : fallbackBriefRecoveryProjection(opts.wctx.sessionId, state),
  };
}

async function runConstitutionGate(
  opts: PlanningPhaseOptions,
): Promise<{ state: WorkflowState; cancelled: boolean }> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, bus } = wctx;
  const dir = sessionDir(projectDir, sessionId);
  let { state } = opts;

  writeSecureFile(join(dir, CLARIFICATIONS_FILE), formatClarificationsPlaceholder());

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'SPEC_CLARIFY_START' });
  publishPlannerStatus(bus, state, 'running');
  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'SPEC_CLARIFY_DONE' });
  publishPlannerStatus(bus, state, 'running');

  const constitutionContent = await readConstitution(projectDir);
  let constitutionResult: ConstitutionCheckResult;
  if (constitutionContent.trim() === '') {
    constitutionResult = { passed: true, violations: [] };
  } else {
    const specText = readSpecFileOrEmpty({ projectDir, sessionId }, SPEC_FILE);
    const constitutionPrompt = buildConstitutionPrompt({
      feature: opts.feature,
      spec: specText,
      constitutionContent,
    });
    const constitutionLoop = await withContinuationLoop<{ state: WorkflowState; text: string }>({
      ctx: {
        projectDir,
        sessionId,
        callbacks: wctx.callbacks,
        bus,
        signal: wctx.signal,
        sinks: wctx.sinks,
      },
      state,
      onStateChange: (s) => {
        state = s;
      },
      body: ({ signal, continuationPrompt, steer }) =>
        runPlannerReview({
          planner,
          prompt: composeSteeredPrompt(continuationPrompt ?? constitutionPrompt, steer),
          projectDir,
          sessionId,
          bus,
          state,
          signal,
        }),
    });
    state = constitutionLoop.value.state;
    constitutionResult = parseConstitutionCheck(constitutionLoop.value.text);
  }
  writeSecureFile(join(dir, CONSTITUTION_CHECK_FILE), JSON.stringify(constitutionResult, null, 2));

  const hardViolation = constitutionResult.violations.find((v) => v.severity === 'hard');
  if (hardViolation || !constitutionResult.passed) {
    const reason = hardViolation?.reason ?? 'constitution check failed';
    bus.publish({
      type: 'warning',
      ts: Date.now(),
      phase: state.phase,
      message: `constitution check failed: ${reason}`,
    });
    state = transitionAndSave({ projectDir, sessionId }, state, {
      type: 'CONSTITUTION_CHECK_FAIL',
    });
    return { state, cancelled: true };
  }

  state = transitionAndSave({ projectDir, sessionId }, state, {
    type: 'CONSTITUTION_CHECK_PASS',
  });
  publishPlannerStatus(bus, state, 'running');

  return { state, cancelled: false };
}
