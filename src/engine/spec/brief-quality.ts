import { z } from 'zod';
import type { Task } from '../../core/schemas/task.js';
import { taskId, TaskIdSchema } from '../../core/schemas/task.js';
import { BriefQualityIssueSchema } from '../../core/schemas/brief-recovery/primitives.js';
import { CONCRETE_FILE_PATH_PATTERN } from '../../utils/path-patterns.js';
import { isRecord } from '../../utils/type-guards.js';
import { clamp01 } from '../../utils/math.js';

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

const briefQualityIssueSchema = BriefQualityIssueSchema.extend({
  code: z.enum(BRIEF_QUALITY_CODES),
  taskId: TaskIdSchema,
});

const briefQualityReportSchema = z.object({
  version: z.literal(1),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(briefQualityIssueSchema),
});

export type BriefQualityIssue = z.infer<typeof briefQualityIssueSchema>;

export type BriefQualityReport = z.infer<typeof briefQualityReportSchema>;

const BRIEF_QUALITY_ISSUE_CODES: ReadonlySet<string> = new Set(BRIEF_QUALITY_CODES);

export function isBriefQualityCode(value: string): value is BriefQualityCode {
  return BRIEF_QUALITY_ISSUE_CODES.has(value);
}

export function firstBriefError(report: BriefQualityReport): BriefQualityIssue | undefined {
  return report.issues.find((issue) => issue.severity === 'error');
}

export function briefErrorMessages(report: BriefQualityReport): string[] {
  return report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
}

export function isBriefQualityReport(value: unknown): value is BriefQualityReport {
  return briefQualityReportSchema.safeParse(value).success;
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

/**
 * `multi_file_task` counts write targets, not mentions. A path in the
 * description/steps counts only when a write verb governs it ("update
 * `src/api.ts`"); paths that are referenced — a pattern exemplar to follow, an
 * import source, a negated "do not modify" — do not. A path with no verdict
 * defaults to reference: a missed multi-file brief is caught downstream by
 * scope enforcement, while a false positive kills quick runs outright.
 */
const WRITE_VERB_PATTERN =
  /^(?:add(?:s|ing)?|append(?:s|ing)?|chang(?:e|es|ing)|creat(?:e|es|ing)|delet(?:e|es|ing)|edit(?:s|ing)?|extend(?:s|ing)?|implement(?:s|ing)?|insert(?:s|ing)?|introduc(?:e|es|ing)|modif(?:y|ies|ying)|mov(?:e|es|ing)|refactor(?:s|ing)?|remov(?:e|es|ing)|renam(?:e|es|ing)|rewrit(?:e|es|ing)|updat(?:e|es|ing)|writ(?:e|es|ing))$/i;

const REFERENCE_MARKER_PATTERN =
  /^(?:based|covered|covering|declared|defined|delivered|example|exemplar|existing|exported|exports|follow|following|follows|from|imported|importing|like|match|matches|matching|mirror|mirroring|mirrors|pattern|per|reference|references|see|sibling|style|unchanged|untouched)$/i;

const NEGATION_PATTERN =
  /^(?:avoid|avoids|avoiding|can'?t|cannot|doesn'?t|don'?t|mustn'?t|never|no|not|shouldn'?t|without|won'?t)$/i;

const CONJUNCTION_GLUE_PATTERN = /^(?:&|also|and|as|plus|then|well)$/i;

const BACKSCAN_TOKEN_LIMIT = 12;

function stripWrapping(token: string): string {
  return token.replace(/[`"'()[\]{}]/g, '');
}

function toWord(token: string): string {
  return token.replace(/[^a-zA-Z']/g, '');
}

function gapDirectsWrite(gap: string): boolean {
  const tokens = gap.split(/\s+/).filter((t) => t.length > 0);
  const windowStart = Math.max(0, tokens.length - BACKSCAN_TOKEN_LIMIT);
  for (let i = tokens.length - 1; i >= windowStart; i--) {
    const raw = stripWrapping(tokens[i] ?? '');
    if (/[.;]$/.test(raw)) return false;
    const word = toWord(raw);
    if (word === '') continue;
    if (REFERENCE_MARKER_PATTERN.test(word)) return false;
    if (WRITE_VERB_PATTERN.test(word)) {
      return !NEGATION_PATTERN.test(toWord(tokens[i - 1] ?? ''));
    }
  }
  return false;
}

function isConjunctionGlue(gap: string): boolean {
  return gap
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zA-Z&]/g, ''))
    .every((word) => word === '' || CONJUNCTION_GLUE_PATTERN.test(word));
}

function collectWriteTargets(unit: string, targets: Map<string, string>): void {
  let previousEnd = -1;
  let previousWasTarget: boolean = false;
  for (const match of unit.matchAll(CONCRETE_FILE_PATH_PATTERN)) {
    const path = match[0];
    const gap = unit.slice(Math.max(previousEnd, 0), match.index);
    const isTarget: boolean =
      previousEnd >= 0 && isConjunctionGlue(gap) ? previousWasTarget : gapDirectsWrite(gap);
    if (isTarget && !targets.has(path.toLowerCase())) targets.set(path.toLowerCase(), path);
    previousWasTarget = isTarget;
    previousEnd = match.index + path.length;
  }
}

function writeTargetFiles(task: Task): string[] {
  const targets = new Map<string, string>();
  for (const unit of [task.description, ...task.implementationSteps]) {
    collectWriteTargets(unit, targets);
  }
  return [...targets.values()];
}

/**
 * The brief-quality verdict is a pure function of the recorded issues, so a
 * consumer holding only a persisted issue list derives the same `passed` and
 * `score` the evaluation produced.
 */
export function briefQualityVerdict(
  issues: readonly unknown[],
): Readonly<{ passed: boolean; score: number }> {
  let errorCount = 0;
  let warningCount = 0;
  for (const issue of issues) {
    const severity = isRecord(issue) ? issue.severity : undefined;
    if (severity === 'error') errorCount += 1;
    else if (severity === 'warning') warningCount += 1;
  }
  return { passed: errorCount === 0, score: clamp01(1 - errorCount * 0.2 - warningCount * 0.05) };
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

    const writeTargets = writeTargetFiles(task);
    if (writeTargets.length >= 2) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        code: 'multi_file_task',
        message: `Task ${task.id} description/steps direct writes to multiple files: ${writeTargets.join(', ')}`,
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

  const { passed, score } = briefQualityVerdict(issues);

  return { version: 1, passed, score, issues };
}
