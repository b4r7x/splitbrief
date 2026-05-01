import type { ResolvedImplementerProfile } from '../../core/config/accessors/implementer-profiles.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import type { Config } from '../../core/schemas/config.js';
import type { ImplementerCostTier, ImplementerWriteMode } from '../../core/schemas/implementer-config.js';
import type { Task } from '../../core/schemas/task.js';
import type { ProjectContext } from '../../core/state/types.js';
import {
  routeTaskToImplementerProfile,
  type CurrentCodeContextMode,
  type RoutingDecision,
  type TaskContextFit,
} from '../../engine/orchestrator/context-routing.js';
import { formatTaskPrompt } from '../../engine/spec/prompt-formatter.js';
import { SYSTEM_PREAMBLE } from '../../engine/spec/prompts/system.js';
import { estimateTokens } from '../../engine/spec/token-budget.js';
import type { PlanTaskReviewMetadata } from '../../stores/workflow/plan-editor.js';
import { redactSecretsWithMetadata } from '../../utils/redact.js';

export interface WorkerPacketPreviewDisplayOptions {
  maxSystemChars?: number | undefined;
  maxPromptChars?: number | undefined;
  maxSystemLines?: number | undefined;
  maxPromptLines?: number | undefined;
}

export interface BuildWorkerPacketPreviewOptions {
  task: Task | undefined;
  context: ProjectContext;
  metadata?: PlanTaskReviewMetadata | undefined;
  routingDecision?: RoutingDecision | undefined;
  config?: Config | undefined;
  profiles?: ResolvedImplementerProfile[] | undefined;
  contextLength?: number | undefined;
  display?: WorkerPacketPreviewDisplayOptions | undefined;
}

export interface WorkerPacketPreview {
  taskId: string;
  workerProfile?: string | undefined;
  costTier?: ImplementerCostTier | undefined;
  requiredWriteMode?: ImplementerWriteMode | undefined;
  selectedWriteMode?: ImplementerWriteMode | undefined;
  contextFit?: TaskContextFit | undefined;
  estimatedTokens?: number | undefined;
  untruncatedEstimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  estimateStatus?: PlanTaskReviewMetadata['estimateStatus'] | undefined;
  stale: boolean;
  checkpoint?: string | undefined;
  conflict?: PlanTaskReviewMetadata['conflict'] | undefined;
  routingPending: boolean;
  refreshRequired: boolean;
  currentCodeContextMode: CurrentCodeContextMode;
  redacted: boolean;
  truncated: boolean;
  systemPreambleRedacted: boolean;
  taskPromptRedacted: boolean;
  systemPreambleTruncated: boolean;
  taskPromptTruncated: boolean;
  visibleSystemPreamble: string;
  visibleTaskPrompt: string;
  notices: readonly string[];
}

const DISPLAY_TRUNCATION_MARKER = '[... display truncated ...]';
const SECRET_REDACTION_MARKER = '[REDACTED]';
const FORMATTER_TRUNCATION_MARKER = '// ... truncated to fit context window ...';
const FUNCTION_CONTEXT_HEADING = '### Current Code (relevant section)';
const WHOLE_FILE_CONTEXT_HEADING = '### Current Code';

function routeFromOptions(opts: BuildWorkerPacketPreviewOptions, task: Task): RoutingDecision | undefined {
  if (opts.routingDecision) return opts.routingDecision;
  if (opts.metadata) return undefined;
  const profiles = opts.profiles ?? (opts.config ? resolveImplementerProfiles(opts.config).profiles : undefined);
  if (!profiles || profiles.length === 0) return undefined;
  return routeTaskToImplementerProfile({ task, context: opts.context, profiles });
}

function promptTaskForPreview(task: Task, metadata: PlanTaskReviewMetadata | undefined): Task {
  if (metadata?.estimateStatus !== 'missing-current-code' && metadata?.estimateStatus !== 'current-code-unavailable') {
    return task;
  }
  const { currentCode: _currentCode, ...withoutCurrentCode } = task;
  return withoutCurrentCode;
}

function effectiveContextLength(
  opts: BuildWorkerPacketPreviewOptions,
  decision: RoutingDecision | undefined,
): number | undefined {
  return decision?.contextLength ?? opts.metadata?.contextLength ?? opts.contextLength;
}

function inferCurrentCodeContextMode(
  task: Task,
  prompt: string,
  decision: RoutingDecision | undefined,
): CurrentCodeContextMode {
  if (decision) return decision.currentCodeContextMode;
  if (task.action !== 'modify' || !task.currentCode) return 'none';
  if (prompt.includes(FUNCTION_CONTEXT_HEADING)) return 'function-level';
  if (prompt.includes(FORMATTER_TRUNCATION_MARKER)) return 'truncated';
  if (!prompt.includes(WHOLE_FILE_CONTEXT_HEADING)) return 'none';
  return prompt.includes(task.currentCode) ? 'whole-file' : 'truncated';
}

function truncateByLines(text: string, maxLines: number | undefined): { text: string; truncated: boolean } {
  if (maxLines === undefined) return { text, truncated: false };
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, truncated: false };
  const omitted = lines.length - maxLines;
  return {
    text: [...lines.slice(0, Math.max(0, maxLines - 1)), `${DISPLAY_TRUNCATION_MARKER} ${omitted} line${omitted === 1 ? '' : 's'} hidden`].join('\n'),
    truncated: true,
  };
}

function truncateByChars(text: string, maxChars: number | undefined): { text: string; truncated: boolean } {
  if (maxChars === undefined || text.length <= maxChars) return { text, truncated: false };
  const marker = `\n${DISPLAY_TRUNCATION_MARKER} ${text.length - maxChars} char${text.length - maxChars === 1 ? '' : 's'} hidden`;
  const visibleLength = Math.max(0, maxChars - marker.length);
  return { text: `${text.slice(0, visibleLength).trimEnd()}${marker}`, truncated: true };
}

function makeVisiblePreview(
  text: string,
  limits: { maxChars?: number | undefined; maxLines?: number | undefined },
): { text: string; redacted: boolean; truncated: boolean } {
  const redacted = redactSecretsWithMetadata(text, { marker: SECRET_REDACTION_MARKER });
  const lineLimited = truncateByLines(redacted.text, limits.maxLines);
  const charLimited = truncateByChars(lineLimited.text, limits.maxChars);
  return {
    text: charLimited.text,
    redacted: redacted.redacted,
    truncated: lineLimited.truncated || charLimited.truncated,
  };
}

function estimateFullPacketTokens(task: Task, context: ProjectContext, contextLength: number | undefined): number {
  return estimateTokens(SYSTEM_PREAMBLE) + estimateTokens(formatTaskPrompt(task, context, contextLength));
}

function buildNotices(opts: {
  decision: RoutingDecision | undefined;
  metadata: PlanTaskReviewMetadata | undefined;
  systemRedacted: boolean;
  promptRedacted: boolean;
  systemTruncated: boolean;
  promptTruncated: boolean;
  routingPending: boolean;
  refreshRequired: boolean;
}): string[] {
  const notices: string[] = [];
  if (!opts.decision && opts.metadata) {
    notices.push('Using review metadata; write-mode and current-code reduction details may be unavailable without a routing decision.');
  }
  if (!opts.decision && !opts.metadata) {
    notices.push('No routing metadata available; preview uses formatter output only.');
  }
  if (opts.systemRedacted || opts.promptRedacted) {
    notices.push('Secret-looking values were redacted from the visible preview.');
  }
  if (opts.systemTruncated || opts.promptTruncated) {
    notices.push('Visible preview was display-truncated; token estimates are based on the full formatted packet.');
  }
  if (opts.routingPending) {
    notices.push('Routing metadata is pending or incomplete; preview may need refresh before dispatch.');
  }
  if (opts.refreshRequired) {
    notices.push('Review metadata is stale or missing current code; refresh before trusting dispatch readiness.');
  }
  if (opts.metadata?.checkpoint) {
    notices.push(`Review metadata checkpoint: ${opts.metadata.checkpoint}.`);
  }
  if (opts.metadata?.conflict) {
    notices.push(`Conflict marker: ${opts.metadata.conflict.kind} (${opts.metadata.conflict.files.join(', ')}).`);
  }
  return notices;
}

function hasPendingRoutingMetadata(
  metadata: PlanTaskReviewMetadata | undefined,
  decision: RoutingDecision | undefined,
): boolean {
  if (decision !== undefined) return false;
  if (metadata === undefined) return true;
  const noCapableWorker = metadata.workerProfile === undefined
    && (metadata.contextFit === 'overflow'
      || (metadata.routingReason?.toLowerCase() ?? '').includes('no capable')
      || (metadata.routingReason?.toLowerCase() ?? '').includes('overflows'));
  return metadata.contextFit === undefined
    || (metadata.workerProfile === undefined && !noCapableWorker)
    || metadata.estimatedTokens === undefined
    || metadata.validationStatus === 'pending';
}

function requiresRefresh(metadata: PlanTaskReviewMetadata | undefined): boolean {
  return metadata?.stale === true
    || metadata?.estimateStatus === 'missing-current-code'
    || metadata?.estimateStatus === 'current-code-unavailable'
    || metadata?.conflict !== undefined;
}

export function buildWorkerPacketPreview(opts: BuildWorkerPacketPreviewOptions): WorkerPacketPreview | null {
  const task = opts.task;
  if (!task) return null;

  const decision = routeFromOptions(opts, task);
  const contextLength = effectiveContextLength(opts, decision);
  const promptTask = promptTaskForPreview(task, opts.metadata);
  const taskPrompt = formatTaskPrompt(promptTask, opts.context, contextLength);
  const visibleSystem = makeVisiblePreview(SYSTEM_PREAMBLE, {
    maxChars: opts.display?.maxSystemChars,
    maxLines: opts.display?.maxSystemLines,
  });
  const visiblePrompt = makeVisiblePreview(taskPrompt, {
    maxChars: opts.display?.maxPromptChars,
    maxLines: opts.display?.maxPromptLines,
  });
  const untruncatedEstimatedTokens = decision?.untruncatedEstimatedTokens
    ?? estimateFullPacketTokens(promptTask, opts.context, undefined);
  const estimatedTokens = decision?.estimatedTokens
    ?? opts.metadata?.estimatedTokens
    ?? estimateFullPacketTokens(promptTask, opts.context, contextLength);
  const routingPending = hasPendingRoutingMetadata(opts.metadata, decision);
  const refreshRequired = requiresRefresh(opts.metadata);

  return {
    taskId: task.id,
    workerProfile: decision?.selectedProfile ?? opts.metadata?.workerProfile,
    costTier: decision?.selectedCostTier ?? opts.metadata?.selectedCostTier,
    requiredWriteMode: decision?.requiredWriteMode,
    selectedWriteMode: decision?.selectedWriteMode,
    contextFit: decision?.fit ?? opts.metadata?.contextFit,
    estimatedTokens,
    untruncatedEstimatedTokens,
    contextLength,
    estimateStatus: opts.metadata?.estimateStatus,
    stale: opts.metadata?.stale === true,
    checkpoint: opts.metadata?.checkpoint,
    conflict: opts.metadata?.conflict,
    routingPending,
    refreshRequired,
    currentCodeContextMode: inferCurrentCodeContextMode(promptTask, taskPrompt, decision),
    redacted: visibleSystem.redacted || visiblePrompt.redacted,
    truncated: visibleSystem.truncated || visiblePrompt.truncated,
    systemPreambleRedacted: visibleSystem.redacted,
    taskPromptRedacted: visiblePrompt.redacted,
    systemPreambleTruncated: visibleSystem.truncated,
    taskPromptTruncated: visiblePrompt.truncated,
    visibleSystemPreamble: visibleSystem.text,
    visibleTaskPrompt: visiblePrompt.text,
    notices: buildNotices({
      decision,
      metadata: opts.metadata,
      systemRedacted: visibleSystem.redacted,
      promptRedacted: visiblePrompt.redacted,
      systemTruncated: visibleSystem.truncated,
      promptTruncated: visiblePrompt.truncated,
      routingPending,
      refreshRequired,
    }),
  };
}
