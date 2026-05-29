import { join } from 'node:path';
import { runFullPlanning } from './full.js';
import { transitionAndSave } from '../state-ops.js';
import { publishPlannerStatus } from '../events.js';
import {
  ANALYZE_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { readFileOrEmpty, writeSecureFile } from '../../../lib/fs.js';
import { buildConstitutionPrompt } from '../../spec/prompts/constitution.js';
import { buildAnalyzePrompt } from '../../spec/prompts/analyze.js';
import { runBriefQualityGate, runBriefsApprovalLoop } from './briefs-approval-loop.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';
import type {
  ConstitutionCheckResult,
  ConstitutionViolation,
} from '../../../core/schemas/constitution.js';
import type { AnalyzeResult } from '../../../core/schemas/analyze.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { extractJsonBlock } from '../../../utils/extract-json-block.js';
import { clamp01 } from '../../../utils/math.js';
import { runPlannerReview } from '../planner-review.js';

export { extractJsonBlock };

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
  return readFileOrEmpty(join(projectDir, '.specify', 'memory', 'constitution.md'));
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

  const constitutionContent = await readConstitution(projectDir);

  state = transitionAndSave(projectDir, sessionId, state, { type: 'SPEC_CLARIFY_START' });
  publishPlannerStatus(bus, state, 'running');
  writeSecureFile(join(dir, CLARIFICATIONS_FILE), formatClarificationsPlaceholder());
  state = transitionAndSave(projectDir, sessionId, state, { type: 'SPEC_CLARIFY_DONE' });
  publishPlannerStatus(bus, state, 'done');

  publishPlannerStatus(bus, state, 'running');
  let constitutionResult: ConstitutionCheckResult;
  if (constitutionContent.trim() === '') {
    constitutionResult = { passed: true, violations: [] };
  } else {
    const prompt = buildConstitutionPrompt({
      feature: opts.feature,
      spec: '',
      constitutionContent,
    });
    const review = await runPlannerReview({
      planner,
      prompt,
      projectDir,
      sessionId,
      bus,
      state,
      signal: wctx.signal,
    });
    state = review.state;
    constitutionResult = parseConstitutionCheck(review.text);
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
    state = transitionAndSave(projectDir, sessionId, state, {
      type: 'CONSTITUTION_CHECK_FAIL',
      reason,
    });
    publishPlannerStatus(bus, state, 'done');
    return { state, tasks: [], cancelled: true };
  }
  state = transitionAndSave(projectDir, sessionId, state, { type: 'CONSTITUTION_CHECK_PASS' });
  publishPlannerStatus(bus, state, 'done');

  const planResult = await runFullPlanning({ ...opts, state, deferBriefGate: true });
  state = planResult.state;
  if (planResult.cancelled) return planResult;
  let tasks = planResult.tasks;

  state = transitionAndSave(projectDir, sessionId, state, { type: 'ANALYZE_START' });
  publishPlannerStatus(bus, state, 'running');

  const [specText, planText, tasksText] = await Promise.all([
    readArtifact(dir, SPEC_FILE),
    readArtifact(dir, PLAN_FILE),
    readArtifact(dir, TASKS_FILE),
  ]);
  const analyzePrompt = buildAnalyzePrompt({ spec: specText, plan: planText, tasks: tasksText });
  const review = await runPlannerReview({
    planner,
    prompt: analyzePrompt,
    projectDir,
    sessionId,
    bus,
    state,
    signal: wctx.signal,
  });
  state = review.state;
  const analysis = parseAnalyze(review.text);
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

  state = transitionAndSave(projectDir, sessionId, state, { type: 'ANALYZE_DONE' });
  publishPlannerStatus(bus, state, 'done');

  runBriefQualityGate({ tasks, projectDir, sessionId, bus, phase: state.phase });

  const briefsLoop = await runBriefsApprovalLoop({
    tasks,
    planner,
    projectDir,
    sessionId,
    callbacks: wctx.callbacks,
    bus,
    state,
    metadata: wctx.metadata,
    signal: wctx.signal,
  });
  state = briefsLoop.state;
  tasks = briefsLoop.tasks;
  if (briefsLoop.rejected) return { state, tasks: [], cancelled: true };

  publishPlannerStatus(bus, state, 'running');
  bus.publish({ type: 'plan_approved', ts: Date.now(), phase: state.phase });

  return { state, tasks, cancelled: false };
}
