import { join } from 'node:path';
import { raisePendingRecovery } from '../state-ops.js';
import { publishPlannerStatus } from '../events.js';
import { buildConstitutionCheckFailedRecoveryIssue } from '../recovery/builders/planner.js';
import { nowIso } from '../../../utils/format-time.js';
import {
  ANALYZE_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
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
import type { PlanningStepsOptions } from './types.js';
import type {
  ConstitutionCheckResult,
  ConstitutionViolation,
} from '../../../core/schemas/constitution.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { AnalyzeResult } from '../../../core/schemas/analyze.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { extractJsonBlock } from '../../../utils/extract-json-block.js';
import { clamp01 } from '../../../utils/math.js';
import { runPlannerReview } from '../planner-review.js';
import { withContinuationLoop } from '../continuation.js';
import { composeContinuation } from '../../spec/prompts/continuation.js';

const DEFAULT_MIN_COVERAGE = 0.9;

/**
 * The extractor answers `{}` for text it could not parse, which is the same shape as a planner
 * that answered with an empty object — neither carries a verdict, so both are malformed here.
 */
function parseJsonVerdict(text: string): Record<string, unknown> | null {
  const obj = narrowRecord(extractJsonBlock(text));
  if (!obj || Object.keys(obj).length === 0) return null;
  return obj;
}

function parseConstitutionCheck(text: string): ConstitutionCheckResult {
  const obj = parseJsonVerdict(text);
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
  const obj = parseJsonVerdict(text);
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

function formatClarificationsPlaceholder(): string {
  return '# Clarifications\n\n_Clarification replies and answers are preserved in session.jsonl. Completed planning documents incorporate those answers._\n';
}

function readSpeckitConfig(opts: PlanningStepsOptions): { minCoverage: number } {
  const min = opts.wctx.config.workflow.speckit?.minCoverage;
  return { minCoverage: typeof min === 'number' ? min : DEFAULT_MIN_COVERAGE };
}

/**
 * The clarify step spends no planner call: the conversation was answered before
 * the spec completed, and its transcript already holds the questions and answers.
 */
export function runClarifyCall(opts: PlanningStepsOptions, state: WorkflowState): WorkflowState {
  const { projectDir, sessionId } = opts.wctx;
  writeSecureFile(
    join(sessionDir(projectDir, sessionId), CLARIFICATIONS_FILE),
    formatClarificationsPlaceholder(),
  );
  return state;
}

/**
 * The constitution check is its own gate: a hard violation parks the run at
 * `constitution-check` with a recovery the operator answers, and never ends it.
 */
export async function runConstitutionCall(
  opts: PlanningStepsOptions,
  initial: WorkflowState,
  feature: string,
): Promise<{ state: WorkflowState; halted: boolean }> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, bus } = wctx;
  const dir = sessionDir(projectDir, sessionId);
  let state = initial;

  const constitutionContent = await confinedReadFileOrEmpty(projectDir, SPECIFY_CONSTITUTION_FILE);
  let constitutionResult: ConstitutionCheckResult;
  if (constitutionContent.trim() === '') {
    constitutionResult = { passed: true, violations: [] };
  } else {
    const specText = readSpecFileOrEmpty({ projectDir, sessionId }, SPEC_FILE);
    const constitutionPrompt = buildConstitutionPrompt({
      feature,
      spec: specText,
      constitutionContent,
    });
    const constitutionStep = { kind: 'planner' as const, call: 'constitution' as const };
    const constitutionSeed = wctx.continuation?.take(constitutionStep);
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
      step: constitutionStep,
      ...(constitutionSeed === undefined ? {} : { seed: constitutionSeed }),
      onStateChange: (s) => {
        state = s;
      },
      body: ({ signal, partial, steer }) =>
        runPlannerReview({
          planner,
          prompt:
            partial === undefined && steer === undefined
              ? constitutionPrompt
              : composeContinuation({ basePrompt: constitutionPrompt, partial, steer }),
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
    const issue = buildConstitutionCheckFailedRecoveryIssue({
      phase: state.phase,
      message: `Constitution check failed: ${reason}`,
      ...(hardViolation !== undefined && {
        details: [`Principle: ${hardViolation.principle}`],
      }),
      createdAt: nowIso(),
    });
    return {
      state: raisePendingRecovery({ projectDir, sessionId, bus }, state, issue),
      halted: true,
    };
  }

  return { state, halted: false };
}

/** Cross-checks the three artifacts and records the coverage it found. */
export async function runAnalyzeCall(
  opts: PlanningStepsOptions,
  initial: WorkflowState,
): Promise<WorkflowState> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, bus } = wctx;
  const dir = sessionDir(projectDir, sessionId);
  let state = initial;

  const [specText, planText, tasksText] = await Promise.all([
    readFileOrEmpty(join(dir, SPEC_FILE)),
    readFileOrEmpty(join(dir, PLAN_FILE)),
    readFileOrEmpty(join(dir, TASKS_FILE)),
  ]);
  const analyzePrompt = buildAnalyzePrompt({ spec: specText, plan: planText, tasks: tasksText });
  const analyzeStep = { kind: 'planner' as const, call: 'analyze' as const };
  const analyzeSeed = wctx.continuation?.take(analyzeStep);
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
    step: analyzeStep,
    ...(analyzeSeed === undefined ? {} : { seed: analyzeSeed }),
    onStateChange: (s) => {
      state = s;
    },
    body: ({ signal, partial, steer }) =>
      runPlannerReview({
        planner,
        prompt:
          partial === undefined && steer === undefined
            ? analyzePrompt
            : composeContinuation({ basePrompt: analyzePrompt, partial, steer }),
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
  return state;
}
