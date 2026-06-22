import type { Task, TaskId } from '../../core/schemas/task.js';
import { taskId } from '../../core/schemas/task.js';
import { CONCRETE_FILE_PATH_PATTERN } from '../../utils/path-patterns.js';
import { isRecord } from '../../utils/type-guards.js';
import { clamp01 } from '../../utils/math.js';

export type BriefQualitySeverity = 'error' | 'warning';

const BRIEF_QUALITY_CODES = [
  'missing_scope',
  'missing_validation',
  'vague_validation',
  'missing_evidence',
  'missing_escalation',
  'missing_code_context',
  'empty_task_list',
  'multi_file_task',
  'missing_type_definitions',
  'missing_implementation_steps',
] as const;

export type BriefQualityCode = (typeof BRIEF_QUALITY_CODES)[number];

export type BriefQualityIssue = {
  taskId: TaskId;
  severity: BriefQualitySeverity;
  code: BriefQualityCode;
  message: string;
};

export type BriefQualityReport = {
  version: 1;
  passed: boolean;
  score: number;
  issues: BriefQualityIssue[];
};

const BRIEF_QUALITY_ISSUE_CODES: ReadonlySet<string> = new Set(BRIEF_QUALITY_CODES);

function isBriefQualityIssue(value: unknown): value is BriefQualityIssue {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === 'string' &&
    (value.severity === 'error' || value.severity === 'warning') &&
    typeof value.code === 'string' &&
    BRIEF_QUALITY_ISSUE_CODES.has(value.code) &&
    typeof value.message === 'string'
  );
}

export function firstBriefError(report: BriefQualityReport): BriefQualityIssue | undefined {
  return report.issues.find((issue) => issue.severity === 'error');
}

export function firstBriefErrorMessage(report: BriefQualityReport): string {
  return firstBriefError(report)?.message ?? 'unknown error';
}

export function isBriefQualityReport(value: unknown): value is BriefQualityReport {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.passed === 'boolean' &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= 1 &&
    Array.isArray(value.issues) &&
    value.issues.every(isBriefQualityIssue)
  );
}

const VAGUE_PATTERNS = [
  /^works?$/i,
  /^works? correctly$/i,
  /^works? as expected$/i,
  /^validate[sd]?$/i,
  /^make sure it works?$/i,
  /^should work(s)?$/i,
  /^it works?$/i,
  /^correct(ly)?$/i,
  /^pass(es)?$/i,
  /^test(s)? pass(es)?$/i,
];

const RISK_PATTERNS = [
  /\bauth\b/i,
  /\bsecurity\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bpayment\b/i,
  /\bdatabase\b/i,
  /\bmigration\b/i,
  /\bconfig\b/i,
  /\bgit\b/i,
  /\bhook\b/i,
  /\bpermission\b/i,
  /public\s+api/i,
];

function isVague(test: string): boolean {
  return VAGUE_PATTERNS.some((p) => p.test(test.trim()));
}

function isRisky(task: Task): boolean {
  const text = [task.description, ...task.implementationSteps].join(' ');
  return RISK_PATTERNS.some((r) => r.test(text));
}

function mentionsMultipleFiles(task: Task): boolean {
  const text = [task.description, ...task.implementationSteps].join(' ');
  const matches = text.match(CONCRETE_FILE_PATH_PATTERN);
  if (!matches) return false;
  const unique = new Set(matches.map((m) => m.toLowerCase()));
  return unique.size >= 2;
}

export function evaluateBriefQuality(tasks: Task[]): BriefQualityReport {
  const issues: BriefQualityIssue[] = [];

  if (tasks.length === 0) {
    issues.push({
      taskId: taskId('T000'),
      severity: 'error',
      code: 'empty_task_list',
      message: 'Planner returned zero Task Briefs',
    });
  }

  for (const task of tasks) {
    if (task.tests.length === 0) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        code: 'missing_validation',
        message: `Task ${task.id} has no tests`,
      });
    } else if (task.tests.every(isVague)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        code: 'vague_validation',
        message: `Task ${task.id} tests are too vague to verify`,
      });
    }

    if (task.implementationSteps.length === 0) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        code: 'missing_implementation_steps',
        message: `Task ${task.id} has no implementation steps`,
      });
    }

    if (mentionsMultipleFiles(task)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        code: 'multi_file_task',
        message: `Task ${task.id} description/steps mention multiple files`,
      });
    }

    if (task.action === 'modify' && !task.currentCode && !task.signature && !task.pattern) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        code: 'missing_code_context',
        message: `Task ${task.id} is a modify action with no code context`,
      });
    }

    if (isRisky(task) && (!task.escalation || task.escalation.length === 0)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        code: 'missing_escalation',
        message: `Task ${task.id} has risk keywords but no escalation rules`,
      });
    }

    if (!task.scope || (!task.scope.inBounds?.length && !task.scope.outOfBounds?.length)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        code: 'missing_scope',
        message: `Task ${task.id} has no scope definition`,
      });
    }

    if (!task.evidence || task.evidence.length === 0) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        code: 'missing_evidence',
        message: `Task ${task.id} has no Evidence field entries`,
      });
    }

    if (!task.typeDefs) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        code: 'missing_type_definitions',
        message: `Task ${task.id} has no type definitions`,
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const score = clamp01(1 - errorCount * 0.2 - warningCount * 0.05);
  const passed = errorCount === 0;

  return { version: 1, passed, score, issues };
}
