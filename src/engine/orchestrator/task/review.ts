import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskReviewMode } from '../../../core/schemas/config.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { EvidenceTask } from '../../../core/schemas/evidence.js';
import type { RoutingDecision } from '../context-routing/types.js';
import { EVIDENCE_FILE, sessionDir } from '../../../core/paths.js';
import { readEvidenceLedger } from '../evidence/persistence.js';

import type { TaskReviewRequest, TaskReviewValidation } from '../../events/workflow-events.js';

interface BuildTaskReviewRequestOptions {
  projectDir: string;
  sessionId: string;
  task: Task;
  state: WorkflowState;
  filesTouched: string[];
  taskBreakdowns: TaskTokenUsage[];
  routingDecision?: RoutingDecision | undefined;
  implementerProfile?: string | undefined;
}

export function shouldReviewTask(opts: {
  mode: TaskReviewMode | undefined;
  request: TaskReviewRequest;
  taskIndex: number;
  currentTaskIndex: number;
}): boolean {
  const mode = opts.mode ?? 'none';
  if (mode === 'none') return false;
  const hasAdvanced = opts.currentTaskIndex > opts.taskIndex;
  const recoveryRequired = opts.request.status === 'recovery-required';
  if (mode === 'every') return hasAdvanced || recoveryRequired;
  return opts.request.status === 'failed' || recoveryRequired || opts.request.validation.passed === false;
}

export function buildTaskReviewRequest(opts: BuildTaskReviewRequestOptions): TaskReviewRequest {
  const ledger = readEvidenceLedger(opts.projectDir, opts.sessionId);
  const evidenceTask = ledger?.tasks.find(task => task.id === opts.task.id);
  const validation = buildValidation(evidenceTask, opts.state);
  const evidencePath = ledger ? join(sessionDir(opts.projectDir, opts.sessionId), EVIDENCE_FILE) : undefined;
  const recovery = opts.state.pendingRecovery?.taskId === opts.task.id ? opts.state.pendingRecovery : undefined;
  const filesTouched = uniqueNonEmpty([
    ...opts.filesTouched,
    ...(evidenceTask?.changedFiles ?? []),
    ...(recovery?.files ?? []),
    opts.task.file,
  ]);
  const taskTokens = opts.taskBreakdowns.find(breakdown => breakdown.taskId === opts.task.id);

  return {
    taskId: opts.task.id,
    taskTitle: opts.task.title,
    status: recovery ? 'recovery-required' : opts.task.status,
    filesTouched,
    validation,
    evidence: {
      ...(evidencePath !== undefined && { path: evidencePath }),
      summary: evidenceSummary(evidenceTask, recovery?.message),
      expected: evidenceTask?.expectedEvidence ?? opts.task.evidence ?? [],
      observed: evidenceTask?.observedEvidence ?? [],
    },
    cost: {
      tokenUsage: opts.state.tokenUsage,
      ...(taskTokens !== undefined && { taskTokens }),
      ...(opts.state.implementerTool !== undefined && { tool: opts.state.implementerTool }),
      ...(opts.state.implementerModel !== undefined && { model: opts.state.implementerModel }),
      ...(opts.implementerProfile !== undefined && { implementerProfile: opts.implementerProfile }),
    },
    ...(opts.routingDecision !== undefined && {
      routing: {
        ...(opts.routingDecision.selectedProfile !== undefined && { selectedProfile: opts.routingDecision.selectedProfile }),
        fit: opts.routingDecision.fit,
        estimatedTokens: opts.routingDecision.estimatedTokens,
        untruncatedEstimatedTokens: opts.routingDecision.untruncatedEstimatedTokens,
        ...(opts.routingDecision.contextLength !== undefined && { contextLength: opts.routingDecision.contextLength }),
        currentCodeTruncated: opts.routingDecision.currentCodeTruncated,
        currentCodeContextMode: opts.routingDecision.currentCodeContextMode,
        costPosture: opts.routingDecision.costPosture,
        reason: opts.routingDecision.reason,
      },
    }),
    ...(recovery !== undefined && {
      recovery: {
        reason: recovery.reason,
        message: recovery.message,
        availableActions: recovery.availableActions,
        recommendedAction: recovery.recommendedAction,
      },
    }),
    availableCommands: ['continue', 'redo', 'edit-notes', 'revise-plan', 'abort'],
  };
}

function buildValidation(evidenceTask: EvidenceTask | undefined, state: WorkflowState): TaskReviewValidation {
  const stages = evidenceTask?.validation.map(entry => ({
    stage: entry.stage,
    passed: entry.passed,
    ...(entry.errorSummary !== undefined && { errorSummary: entry.errorSummary }),
  })) ?? [];
  if (stages.length > 0) {
    const passed = stages.every(stage => stage.passed);
    return {
      passed,
      summary: passed ? 'validation passed' : validationFailureSummary(stages),
      stages,
    };
  }
  const recovery = state.pendingRecovery;
  const validationSummary = typeof recovery?.facts?.validationSummary === 'string'
    ? recovery.facts.validationSummary
    : undefined;
  return {
    passed: recovery ? false : null,
    summary: validationSummary ?? (recovery ? recovery.message : 'validation not recorded'),
    stages,
  };
}

function validationFailureSummary(stages: TaskReviewValidation['stages']): string {
  const failed = stages.find(stage => !stage.passed);
  return failed?.errorSummary ?? (failed ? `${failed.stage} failed` : 'validation failed');
}

function evidenceSummary(task: EvidenceTask | undefined, fallback: string | undefined): string {
  if (!task) return fallback ?? 'no evidence ledger entry recorded yet';
  if (task.observedEvidence.length > 0) return task.observedEvidence.slice(0, 3).join('; ');
  return fallback ?? 'no observed evidence recorded yet';
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
