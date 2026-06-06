import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedImplementerProfile } from '../../core/config/accessors/implementer-profiles.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import type { Config } from '../../core/schemas/config.js';
import type {
  ImplementerCostTier,
  ImplementerWriteMode,
} from '../../core/schemas/implementer-config.js';
import type { Task } from '../../core/schemas/task.js';
import type { ProjectContext } from '../../core/state/types.js';
import type {
  PlanReviewEstimateStatus,
  PlanReviewRisk,
  PlanTaskReviewMetadata,
} from '../../core/plan-review/types.js';
import { hasNoCapableWorker, hasStaleOrConflict } from '../../core/plan-review/predicates.js';
import { routeTaskToImplementerProfile } from '../orchestrator/context-routing/route.js';
import { currentCodeContextMode as inferCurrentCodeContextModeFromPrompt } from '../orchestrator/context-routing/headings.js';
import type { RoutingDecision } from '../orchestrator/context-routing/types.js';
import type { CurrentCodeContextMode, TaskContextFit } from '../../core/schemas/enums.js';
import { formatTaskPrompt } from '../spec/prompt-formatter.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import { buildProjectLanguageContext } from '../spec/prompts/language-context.js';
import { buildSystemPreamble } from '../spec/prompts/system.js';
import { pluralize } from '../../utils/pluralize.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { isENOENT } from '../../lib/process/errors.js';
import { assertWritablePathConfined } from '../../lib/path-confinement.js';
import { redactSecretsWithMetadata } from '../../utils/redact.js';

export type { RoutingDecision };

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
  languageContext?: LanguageContext | undefined;
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

function routeFromOptions(
  opts: BuildWorkerPacketPreviewOptions,
  task: Task,
): RoutingDecision | undefined {
  if (opts.routingDecision) return opts.routingDecision;
  if (opts.metadata) return undefined;
  const profiles =
    opts.profiles ?? (opts.config ? resolveImplementerProfiles(opts.config).profiles : undefined);
  if (!profiles || profiles.length === 0) return undefined;
  const languageContext =
    opts.languageContext ?? buildProjectLanguageContext(opts.context.dir, undefined);
  return routeTaskToImplementerProfile({ task, context: opts.context, profiles, languageContext });
}

function promptTaskForPreview(task: Task, metadata: PlanTaskReviewMetadata | undefined): Task {
  if (
    metadata?.estimateStatus !== 'missing-current-code' &&
    metadata?.estimateStatus !== 'current-code-unavailable'
  ) {
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
  return inferCurrentCodeContextModeFromPrompt(task, prompt);
}

function truncateByLines(
  text: string,
  maxLines: number | undefined,
): { text: string; truncated: boolean } {
  if (maxLines === undefined) return { text, truncated: false };
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, truncated: false };
  const omitted = lines.length - maxLines;
  return {
    text: [
      ...lines.slice(0, Math.max(0, maxLines - 1)),
      `${DISPLAY_TRUNCATION_MARKER} ${omitted} ${pluralize(omitted, 'line')} hidden`,
    ].join('\n'),
    truncated: true,
  };
}

function truncateByChars(
  text: string,
  maxChars: number | undefined,
): { text: string; truncated: boolean } {
  if (maxChars === undefined || text.length <= maxChars) return { text, truncated: false };
  const marker = `\n${DISPLAY_TRUNCATION_MARKER} ${text.length - maxChars} ${pluralize(text.length - maxChars, 'char')} hidden`;
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

function estimateFullPacketTokens(
  task: Task,
  context: ProjectContext,
  contextLength: number | undefined,
  languageContext: LanguageContext,
): number {
  return (
    estimateTokens(buildSystemPreamble(languageContext)) +
    estimateTokens(formatTaskPrompt({ task, context, contextLength, languageContext }))
  );
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
    notices.push(
      'Using review metadata; write-mode and current-code reduction details may be unavailable without a routing decision.',
    );
  }
  if (!opts.decision && !opts.metadata) {
    notices.push('No routing metadata available; preview uses formatter output only.');
  }
  if (opts.systemRedacted || opts.promptRedacted) {
    notices.push('Secret-looking values were redacted from the visible preview.');
  }
  if (opts.systemTruncated || opts.promptTruncated) {
    notices.push(
      'Visible preview was display-truncated; token estimates are based on the full formatted packet.',
    );
  }
  if (opts.routingPending) {
    notices.push(
      'Routing metadata is pending or incomplete; preview may need refresh before dispatch.',
    );
  }
  if (opts.refreshRequired) {
    notices.push(
      'Review metadata is stale or missing current code; refresh before trusting dispatch readiness.',
    );
  }
  if (opts.metadata?.checkpoint) {
    notices.push(`Review metadata checkpoint: ${opts.metadata.checkpoint}.`);
  }
  if (opts.metadata?.conflict) {
    notices.push(
      `Conflict marker: ${opts.metadata.conflict.kind} (${opts.metadata.conflict.files.join(', ')}).`,
    );
  }
  return notices;
}

function hasPendingRoutingMetadata(
  metadata: PlanTaskReviewMetadata | undefined,
  decision: RoutingDecision | undefined,
): boolean {
  if (decision !== undefined) return false;
  if (metadata === undefined) return true;
  return (
    metadata.contextFit === undefined ||
    (metadata.workerProfile === undefined && !hasNoCapableWorker(metadata)) ||
    metadata.estimatedTokens === undefined ||
    metadata.validationStatus === 'pending'
  );
}

function requiresRefresh(metadata: PlanTaskReviewMetadata | undefined): boolean {
  return hasStaleOrConflict(metadata);
}

export function buildWorkerPacketPreview(
  opts: BuildWorkerPacketPreviewOptions,
): WorkerPacketPreview | null {
  const task = opts.task;
  if (!task) return null;

  const languageContext =
    opts.languageContext ?? buildProjectLanguageContext(opts.context.dir, undefined);
  const decision = routeFromOptions(opts, task);
  const contextLength = effectiveContextLength(opts, decision);
  const promptTask = promptTaskForPreview(task, opts.metadata);
  const systemPreamble = buildSystemPreamble(languageContext);
  const taskPrompt = formatTaskPrompt({
    task: promptTask,
    context: opts.context,
    contextLength,
    languageContext,
  });
  const visibleSystem = makeVisiblePreview(systemPreamble, {
    maxChars: opts.display?.maxSystemChars,
    maxLines: opts.display?.maxSystemLines,
  });
  const visiblePrompt = makeVisiblePreview(taskPrompt, {
    maxChars: opts.display?.maxPromptChars,
    maxLines: opts.display?.maxPromptLines,
  });
  const untruncatedEstimatedTokens =
    decision?.untruncatedEstimatedTokens ??
    estimateFullPacketTokens(promptTask, opts.context, undefined, languageContext);
  const estimatedTokens =
    decision?.estimatedTokens ??
    opts.metadata?.estimatedTokens ??
    estimateFullPacketTokens(promptTask, opts.context, contextLength, languageContext);
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

function previewProjectContext(projectDir: string, testCommand: string): ProjectContext {
  return { name: 'unknown', dir: projectDir, runtime: 'node', testCommand };
}

export function routeTaskForPreview(opts: {
  task: Task;
  config: Config;
  projectDir: string;
  testCommand: string;
}): RoutingDecision {
  const profiles = resolveImplementerProfiles(opts.config).profiles;
  return routeTaskToImplementerProfile({
    task: opts.task,
    context: previewProjectContext(opts.projectDir, opts.testCommand),
    profiles,
    languageContext: buildProjectLanguageContext(opts.projectDir, undefined),
  });
}

export function buildRoutingPreviewMetadata(
  tasks: Task[],
  opts: { config: Config; projectDir: string },
): Promise<PlanTaskReviewMetadata[]> {
  const context = previewProjectContext(
    opts.projectDir,
    opts.config.validation.testCommand ?? 'npm test',
  );
  const profiles = resolveImplementerProfiles(opts.config).profiles;

  return Promise.all(
    tasks.map(async (task) => {
      const { task: routingTask, estimateStatus } = await refreshTaskForRoutingPreview(
        task,
        opts.projectDir,
      );
      const decision = routeTaskToImplementerProfile({
        task: routingTask,
        context,
        profiles,
        languageContext: buildProjectLanguageContext(opts.projectDir, undefined),
      });
      const routeBlocked = decision.selectedProfile === undefined;
      const risk: PlanReviewRisk =
        routeBlocked ||
        estimateStatus === 'missing-current-code' ||
        estimateStatus === 'current-code-unavailable'
          ? 'high'
          : decision.fit === 'overflow'
            ? 'high'
            : routingTask.action === 'modify' || decision.fit === 'tight'
              ? 'medium'
              : 'low';
      const routingReason = routingPreviewReason(decision.reason, estimateStatus);

      return {
        taskId: routingTask.id,
        ...(decision.selectedProfile !== undefined && { workerProfile: decision.selectedProfile }),
        ...(decision.selectedCostTier !== undefined && {
          selectedCostTier: decision.selectedCostTier,
        }),
        costPosture: decision.costPosture,
        contextFit: decision.fit,
        estimatedTokens: decision.estimatedTokens,
        ...(decision.contextLength !== undefined && { contextLength: decision.contextLength }),
        ...(estimateStatus !== undefined && { estimateStatus }),
        routingReason,
        ...(routeBlocked && { routingBlockKind: 'no-capable-worker' as const }),
        currentCodeContextMode: decision.currentCodeContextMode,
        currentCodeTruncated: decision.currentCodeTruncated,
        ...(routeBlocked ||
        estimateStatus === 'missing-current-code' ||
        estimateStatus === 'current-code-unavailable'
          ? { validationStatus: 'warn' as const }
          : {}),
        risk,
      };
    }),
  );
}

export async function refreshTaskForRoutingPreview(
  task: Task,
  projectDir: string,
): Promise<{ task: Task; estimateStatus?: PlanReviewEstimateStatus | undefined }> {
  if (task.action !== 'modify') return { task };

  try {
    assertWritablePathConfined(task.file, projectDir);
    const currentCode = await readFile(join(projectDir, task.file), 'utf-8');
    return { task: { ...task, currentCode }, estimateStatus: 'refreshed-current-code' };
  } catch (err) {
    const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
    return {
      task: taskWithoutCurrentCode,
      estimateStatus: isENOENT(err) ? 'missing-current-code' : 'current-code-unavailable',
    };
  }
}

function routingPreviewReason(
  reason: string,
  estimateStatus?: PlanReviewEstimateStatus | undefined,
): string {
  if (estimateStatus === 'missing-current-code') {
    return `${reason}; review estimate is missing current code because the target file was not readable at review time`;
  }
  if (estimateStatus === 'current-code-unavailable') {
    return `${reason}; review estimate could not refresh current code`;
  }
  return reason;
}
