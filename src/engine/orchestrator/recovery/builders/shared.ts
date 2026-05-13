import type { Phase, RecoveryAction, RecoveryReason } from '../../../../core/schemas/enums.js';
import type { RecoveryFact, RecoveryIssue } from '../../../../core/schemas/recovery.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import type { ValidationResult } from '../../validation.js';
import type { UserEditConflict, UserEditConflictAction } from '../../user-edit/conflicts.js';
import { uniqueIds, uniqueSorted } from '../../../../utils/collections.js';
import { looksLikeFilePath } from '../../../../utils/path-patterns.js';

const ACTION_ORDER: RecoveryAction[] = [
  'retry-same-worker',
  'route-bigger-worker',
  'planner-split-rebase',
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
];

export const MAX_SUMMARY_LENGTH = 320;

export interface RecoveryBuilderBase {
  createdAt: string;
  id?: string | undefined;
}

export interface TaskRecoveryContext {
  task: Task;
  phase?: Phase | undefined;
  attempts?: number | undefined;
  maxAttempts?: number | undefined;
  selectedImplementerProfile?: string | undefined;
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}

export function buildRecoveryIssueId(opts: {
  reason: RecoveryReason;
  phase: Phase;
  taskId?: TaskId | undefined;
  createdAt: string;
}): string {
  const stamp = opts.createdAt.replace(/\D/g, '').slice(0, 14) || 'unknown';
  const reason = opts.reason.replaceAll('-', '_');
  const phase = opts.phase.replaceAll('-', '_');
  const task = opts.taskId ? `_${opts.taskId}` : '';
  return `rec_${stamp}_${reason}_${phase}${task}`;
}

export function createRecoveryIssue(opts: {
  id?: string | undefined;
  reason: RecoveryReason;
  phase: Phase;
  task?: Task | undefined;
  files: string[];
  affectedTaskIds: TaskId[];
  message: string;
  details: string[];
  attempts?: number | undefined;
  maxAttempts?: number | undefined;
  selectedImplementerProfile?: string | undefined;
  facts?: Record<string, RecoveryFact> | undefined;
  availableActions: RecoveryAction[];
  recommendedAction: RecoveryAction;
  createdAt: string;
}): RecoveryIssue {
  const issue: RecoveryIssue = {
    id: opts.id ?? buildRecoveryIssueId({
      reason: opts.reason,
      phase: opts.phase,
      taskId: opts.task?.id,
      createdAt: opts.createdAt,
    }),
    reason: opts.reason,
    phase: opts.phase,
    status: 'awaiting-user',
    ...(opts.task ? { taskId: opts.task.id, taskTitle: opts.task.title } : {}),
    files: uniqueSorted(opts.files, { trim: true, nonEmpty: true }),
    affectedTaskIds: uniqueIds(opts.affectedTaskIds),
    message: opts.message,
    details: opts.details.map(summarizeText).filter(detail => detail.length > 0),
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.selectedImplementerProfile !== undefined ? { selectedImplementerProfile: opts.selectedImplementerProfile } : {}),
    ...(opts.facts !== undefined && Object.keys(opts.facts).length > 0 ? { facts: opts.facts } : {}),
    availableActions: opts.availableActions,
    recommendedAction: opts.recommendedAction,
    createdAt: opts.createdAt,
  };
  return issue;
}

export function orderedActions(actions: Array<RecoveryAction | undefined>): RecoveryAction[] {
  const requested = new Set(actions.filter(action => action !== undefined));
  return ACTION_ORDER.filter(action => requested.has(action));
}

export function chooseRecommended(actions: RecoveryAction[], preferences: RecoveryAction[]): RecoveryAction {
  for (const preference of preferences) {
    if (actions.includes(preference)) return preference;
  }
  return actions[0] ?? 'pause-run';
}

export function chooseUserEditRecommendation(conflict: UserEditConflict, actions: RecoveryAction[]): RecoveryAction {
  if (conflict.safeToContinue && actions.includes('continue')) return 'continue';
  return chooseRecommended(actions, ['planner-split-rebase', 'pause-run']);
}

export function mapUserEditAction(action: UserEditConflictAction): RecoveryAction {
  if (action === 'continue-unrelated') return 'continue';
  if (action === 'regenerate-rebase') return 'planner-split-rebase';
  if (action === 'pause') return 'pause-run';
  return action;
}

export function hasRetryBudget(attempts: number | undefined, maxAttempts: number | undefined): boolean {
  if (attempts === undefined || maxAttempts === undefined) return true;
  return attempts < maxAttempts;
}

export function hasRouteBigger(opts: {
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}): boolean {
  if (opts.canRouteBigger === false) return false;
  return opts.routeBiggerProfile !== undefined || opts.canRouteBigger === true;
}

export function summarizeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return summarizeText(error.message || error.name);
  }
  if (typeof error === 'string') return summarizeText(error);
  return 'Unknown implementation error';
}

export function summarizeValidation(opts: {
  validationResults?: ValidationResult[] | undefined;
  validationSummary?: string | undefined;
}): { detail: string; summary: string; stage?: ValidationResult['stage'] | undefined } {
  if (opts.validationSummary !== undefined && opts.validationSummary.trim().length > 0) {
    const summary = summarizeText(opts.validationSummary);
    return { detail: `Validation: ${summary}`, summary };
  }

  const failed = opts.validationResults?.find(result => !result.passed);
  if (!failed) {
    return {
      detail: 'Validation failed without a reported failing stage.',
      summary: 'Validation failed without a reported failing stage.',
    };
  }

  const summary = summarizeText(failed.error || failed.output || `${failed.stage} failed`);
  return {
    detail: `Validation ${failed.stage} failed: ${summary}`,
    summary,
    stage: failed.stage,
  };
}

export function summarizeText(input: string): string {
  const normalized = input.trim().replace(/\s+/g, ' ');
  if (normalized.length <= MAX_SUMMARY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

export function attemptDetails(attempts: number | undefined, maxAttempts: number | undefined): string[] {
  if (attempts === undefined && maxAttempts === undefined) return [];
  if (attempts !== undefined && maxAttempts !== undefined) return [`Attempts: ${attempts}/${maxAttempts}`];
  if (attempts !== undefined) return [`Attempts: ${attempts}`];
  return [`Max attempts: ${maxAttempts}`];
}

export function implementerDetails(selectedImplementerProfile: string | undefined): string[] {
  return selectedImplementerProfile ? [`Worker profile: ${selectedImplementerProfile}`] : [];
}

export function routeBiggerDetails(opts: {
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}): string[] {
  if (opts.routeBiggerProfile) return [`Bigger worker available: ${opts.routeBiggerProfile}`];
  if (opts.canRouteBigger) return ['Bigger worker available'];
  return [];
}

export function taskFiles(task: Task): string[] {
  return uniqueSorted([
    task.file,
    ...(task.scope?.inBounds ?? []).filter(looksLikeFilePath),
    ...(task.scope?.approvedOutOfBounds ?? []).filter(looksLikeFilePath),
  ], { trim: true, nonEmpty: true });
}

export function fileConflictDetails(conflict: UserEditConflict): string[] {
  return conflict.fileConflicts.map(fileConflict => {
    const affected = fileConflict.affectedTaskIds.length > 0
      ? ` affects ${fileConflict.affectedTaskIds.join(', ')}`
      : '';
    return `${fileConflict.file}: ${fileConflict.kind}${affected}`;
  });
}

export function compactFacts(values: Record<string, RecoveryFact | undefined>): Record<string, RecoveryFact> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, RecoveryFact] => entry[1] !== undefined),
  );
}

export function budgetPercentOf(currentCost: number, maxBudget: number): number {
  if (!Number.isFinite(currentCost) || !Number.isFinite(maxBudget) || maxBudget <= 0) return 0;
  return Math.round((currentCost / maxBudget) * 10_000) / 100;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  return `${Math.round(value)}%`;
}

export function formatCostFact(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return `$${value.toFixed(2)}`;
}

