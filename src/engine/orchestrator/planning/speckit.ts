import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFullPlanning } from './new.js';
import { transitionAndSave } from '../state-ops.js';
import { publishPlannerStatus, createBusTextHandler, publishEvent } from '../events.js';
import {
  ANALYZE_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { buildConstitutionPrompt } from '../../spec/prompts/constitution.js';
import { buildAnalyzePrompt } from '../../spec/prompts/analyze.js';
import { runBriefQualityGate, runBriefsApprovalLoop } from './shared.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './shared.js';
import type { ConstitutionCheckResult, ConstitutionViolation } from '../../../core/schemas/constitution.js';
import type { AnalyzeResult } from '../../../core/schemas/analyze.js';

const DEFAULT_MIN_COVERAGE = 0.9;

export function extractJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced ? fenced[1] : findFirstBalancedObject(text);
  if (!candidate) return {};
  try {
    return JSON.parse(candidate);
  } catch {
    return {};
  }
}

function findFirstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseConstitutionCheck(text: string): ConstitutionCheckResult {
  const json = extractJsonBlock(text);
  if (!json || typeof json !== 'object') {
    return { passed: true, violations: [{ principle: 'meta', reason: 'constitution check output malformed', severity: 'soft' }] };
  }
  const obj = json as Record<string, unknown>;
  const passed = typeof obj.passed === 'boolean' ? obj.passed : true;
  const rawViolations = Array.isArray(obj.violations) ? obj.violations : [];
  const violations: ConstitutionViolation[] = [];
  for (const v of rawViolations) {
    if (!v || typeof v !== 'object') continue;
    const rec = v as Record<string, unknown>;
    const principle = typeof rec.principle === 'string' ? rec.principle : 'unknown';
    const reason = typeof rec.reason === 'string' ? rec.reason : '';
    const severity: 'hard' | 'soft' = rec.severity === 'hard' ? 'hard' : 'soft';
    violations.push({ principle, reason, severity });
  }
  return { passed, violations };
}

function parseAnalyze(text: string): AnalyzeResult {
  const json = extractJsonBlock(text);
  const fallback: AnalyzeResult = {
    specTaskCoverage: 0,
    planTaskCoverage: 0,
    orphanTasks: [],
    unaddressedSpecSections: [],
    warnings: ['analyze output malformed'],
  };
  if (!json || typeof json !== 'object') return fallback;
  const obj = json as Record<string, unknown>;
  const num = (v: unknown, def: number): number => {
    if (typeof v !== 'number' || Number.isNaN(v)) return def;
    return Math.max(0, Math.min(1, v));
  };
  const strArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    specTaskCoverage: num(obj.specTaskCoverage, 0),
    planTaskCoverage: num(obj.planTaskCoverage, 0),
    orphanTasks: strArr(obj.orphanTasks),
    unaddressedSpecSections: strArr(obj.unaddressedSpecSections),
    warnings: strArr(obj.warnings),
  };
}

function readConstitution(projectDir: string): string {
  const p = join(projectDir, '.specify', 'memory', 'constitution.md');
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function readArtifact(dir: string, file: string): string {
  const p = join(dir, file);
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function formatClarificationsPlaceholder(): string {
  return '# Clarifications\n\n_Inline clarifications collected during the spec phase are appended to spec.md. See spec.md for the answered questions._\n';
}

function readSpeckitConfig(opts: PlanningPhaseOptions): { minCoverage: number } {
  const wf = opts.wctx.config.workflow as { speckit?: { minCoverage?: number } } | undefined;
  const min = wf?.speckit?.minCoverage;
  return { minCoverage: typeof min === 'number' ? min : DEFAULT_MIN_COVERAGE };
}

export async function runSpeckitPlanning(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, bus } = wctx;
  const dir = sessionDir(projectDir, sessionId);
  let { state } = opts;

  const constitutionContent = readConstitution(projectDir);

  state = transitionAndSave(projectDir, sessionId, state, { type: 'SPEC_CLARIFY_START' });
  publishPlannerStatus(bus, state, 'running');
  writeFileSync(join(dir, CLARIFICATIONS_FILE), formatClarificationsPlaceholder(), 'utf8');
  state = transitionAndSave(projectDir, sessionId, state, { type: 'SPEC_CLARIFY_DONE' });
  publishPlannerStatus(bus, state, 'done');

  publishPlannerStatus(bus, state, 'running');
  let constitutionResult: ConstitutionCheckResult;
  if (constitutionContent.trim() === '') {
    constitutionResult = { passed: true, violations: [] };
  } else {
    const prompt = buildConstitutionPrompt(opts.feature, '', constitutionContent);
    const onOutput = createBusTextHandler(bus, state.phase);
    const review = await planner.review(prompt, projectDir, { onOutput });
    constitutionResult = parseConstitutionCheck(review.text);
  }
  writeFileSync(join(dir, CONSTITUTION_CHECK_FILE), JSON.stringify(constitutionResult, null, 2), 'utf8');

  const hardViolation = constitutionResult.violations.find(v => v.severity === 'hard');
  if (hardViolation || !constitutionResult.passed) {
    const reason = hardViolation?.reason ?? 'constitution check failed';
    bus.publish({ type: 'warning', ts: Date.now(), phase: state.phase, message: `constitution check failed: ${reason}` });
    state = transitionAndSave(projectDir, sessionId, state, { type: 'CONSTITUTION_CHECK_FAIL', reason });
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

  const specText = readArtifact(dir, SPEC_FILE);
  const planText = readArtifact(dir, PLAN_FILE);
  const tasksText = readArtifact(dir, TASKS_FILE);
  const analyzePrompt = buildAnalyzePrompt(specText, planText, tasksText);
  const onOutput = createBusTextHandler(bus, state.phase);
  const review = await planner.review(analyzePrompt, projectDir, { onOutput });
  const analysis = parseAnalyze(review.text);
  writeFileSync(join(dir, ANALYZE_FILE), JSON.stringify(analysis, null, 2), 'utf8');

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

  runBriefQualityGate(tasks, projectDir, sessionId, bus, state.phase);

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
  publishEvent(bus, { type: 'plan_approved', ts: Date.now(), phase: state.phase });

  return { state, tasks, cancelled: false };
}
