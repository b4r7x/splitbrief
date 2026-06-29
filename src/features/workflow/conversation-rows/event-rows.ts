import { formatCost, formatScoreSummary } from '../../../core/formatting.js';
import { formatModelName } from '../../../core/model-display.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { formatDuration } from '../../../utils/format-time.js';
import { hasTaskBriefMetadataKeys, parseMarkdownYamlKey } from '../../../utils/markdown/grammar.js';
import { parseMarkdownBlocks } from '../../../utils/markdown/block-parser.js';
import { countNoun, pluralize } from '../../../utils/pluralize.js';
import { assertNever } from '../../../utils/type-guards.js';
import { glyph } from '../../../lib/glyphs.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import { borderedCardRowsBlock } from './bordered-card-block.js';
import { calloutRowsBlock } from './callout-block.js';
import { costPredictionRows } from './cost-prediction-rows.js';
import {
  formatExternalChangesValue,
  formatTaskStartedValue,
  validationRow,
} from './event-format.js';
import type {
  ConversationRow,
  ConversationRowBlock,
  ConversationRowTone,
  RowBuildContext,
} from './types.js';
import { sanitizeRowDisplayText } from './row-format.js';
import { implementerExpandedDiffCardBlock } from './implementer-diff-card-block.js';
import { markdownPlannerTextRowBlock } from './planner-markdown-row-block.js';
import {
  cardRowsBlock,
  compositeBlock,
  rowSeedsBlock,
  rowsBlock,
  wrappedTextBlock,
} from './row-block-compose.js';
import { taskStartedRowBlock } from './task-started-row-block.js';
import { isRunnerCallTranscriptRowSuppressed } from './runner-call-classification.js';

export function eventRows(options: {
  event: EngineEvent;
  globalIndex: number;
  ctx: RowBuildContext;
  expanded: boolean;
}): ConversationRow[] {
  const block = eventRowBlock(options);
  return block === null ? [] : block.createRows(0, block.rowCount);
}

export function eventRowBlock(options: {
  event: EngineEvent;
  globalIndex: number;
  ctx: RowBuildContext;
  expanded: boolean;
}): ConversationRowBlock | null {
  const { event, globalIndex, ctx, expanded } = options;
  const keyPrefix = `event-${globalIndex}-${event.type}`;

  if (isRunnerCallTranscriptRowSuppressed(event)) return null;

  switch (event.type) {
    case 'workflow_started':
    case 'workflow_resumed':
    case 'workflow_complete':
    case 'workflow_config':
    case 'spec_rejected':
    case 'spec_regenerated':
    case 'plan_approved':
    case 'plan_rejected':
    case 'plan_regenerated':
    case 'all_tasks_done':
    case 'planner_status':
    case 'planner_heartbeat':
    case 'drift_chain_detected':
    case 'snapshot_created':
    case 'snapshot_restored':
    case 'snapshot_restore_conflict':
    case 'mode_resolved':
    case 'mode_advice':
    case 'instant_plan_received':
    case 'task_completed':
    case 'task_escalating':
    case 'task_tokens':
    case 'task_review_needed':
    case 'hint_failed':
    case 'cost_update':
    case 'approval_prompted':
    case 'approval_granted':
    case 'approval_rejected':
    case 'approval_sticky_recorded':
    case 'ipc_server_started':
    case 'ipc_client_attached':
    case 'ipc_client_detached':
    case 'ipc_reconnect_attempt':
    case 'ipc_reconnect_failed':
    case 'replay_started':
    case 'replay_complete':
    case 'clarifications_collected':
    case 'clarification_answered':
      return null;
    case 'workflow_cancelled':
      return rowSeedsBlock(keyPrefix, [
        { key: `${keyPrefix}-title`, text: 'Workflow cancelled', tone: 'textDim', bold: true },
      ]);
    case 'paused_external_changes':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'user edits',
        value: formatExternalChangesValue(event),
        width: ctx.width,
        labelTone: event.conflict?.safeToContinue ? 'textDim' : 'error',
      });
    case 'recovery_prompted':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `${event.reason}${event.taskId ? ` · ${event.taskId}` : ''} · recommended ${event.recommendedAction}`,
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'recovery_action_selected':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `selected ${event.action} for ${event.reason}`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'recovery_action_failed':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `${event.action} blocked: ${event.message}`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    case 'recovery_resolved':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `${event.outcome} via ${event.action}${event.implementerProfile ? ` · ${event.implementerProfile}` : ''}`,
        width: ctx.width,
        labelTone: recoveryResolvedTone(event.outcome),
        valueTone: recoveryResolvedTone(event.outcome),
      });
    case 'planner_text':
      return plannerTextRowBlock({ event, keyPrefix, width: ctx.width });
    case 'rewind_to_spec':
      return cardRowsBlock({
        keyPrefix,
        label: `rewind ${glyph('connectorHandoff')} spec`,
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'rewind_to_plan':
      return cardRowsBlock({
        keyPrefix,
        label: `rewind ${glyph('connectorHandoff')} plan`,
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'brief_quality_passed':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'brief quality',
        value: `passed · ${formatScoreSummary(event.score, { errorCount: 0, warningCount: event.warningCount })}`,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'brief_quality_failed':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'brief quality',
        value: `failed · ${formatScoreSummary(event.score, {
          errorCount: event.errorCount,
          warningCount: event.warningCount,
        })}`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    case 'drift_report':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'drift',
        value: formatScoreSummary(event.score, {
          errorCount: event.errorCount,
          warningCount: event.warningCount,
        }),
        width: ctx.width,
        labelTone: event.passed ? 'success' : 'textDim',
        valueTone: 'textDim',
      });
    case 'mode_downgrade_advised':
      return wrappedTextBlock({
        keyPrefix,
        text: `This looks trivial. Consider --mode ${event.suggestedMode} instead of --mode ${event.currentMode}.`,
        width: ctx.width,
        tone: 'textDim',
      });
    case 'task_started':
      return taskStartedRowBlock({
        keyPrefix,
        index: event.index,
        title: event.title,
        metadata: formatTaskStartedValue(event),
        width: ctx.width,
      });
    case 'task_skipped':
      return cardRowsBlock({
        keyPrefix,
        label: 'skipped',
        value: `${event.taskId} ${event.title}: ${event.reason}`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'task_full_fail':
      return cardRowsBlock({
        keyPrefix,
        label: 'task failed',
        value: event.taskId,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
        kind: 'summary',
      });
    case 'task_retry':
      return wrappedTextBlock({
        keyPrefix,
        text: `retry  attempt ${event.attempt}/${event.maxRetries}`,
        width: ctx.width,
        tone: 'textDim',
      });
    case 'task_reset':
      return cardRowsBlock({
        keyPrefix,
        label: 'task reset',
        value: `Task ${event.taskId} set to pending`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'implementer_generate_running':
      return runningImplementerRowBlock(keyPrefix, event, ctx);
    case 'implementer_generate_done':
      return implementerDoneRowBlock(keyPrefix, event, ctx, expanded);
    case 'implementer_generate_failed':
      return cardRowsBlock({
        keyPrefix,
        label: 'failed',
        value: formatModelName(event.model),
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    case 'validate':
      return validateRowBlock(keyPrefix, event, ctx.width);
    case 'escalate':
      return escalateRowBlock(keyPrefix, event, ctx.width);
    case 'git_commit':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'committed',
        value: event.message,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'git_checkpoint':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'checkpoint',
        value: event.tag,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'git_branch_created':
      return cardRowsBlock({
        keyPrefix,
        label: 'branch',
        value: event.name,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'message_queued':
      return cardRowsBlock({
        keyPrefix,
        label: 'queued',
        value: queueMessageValue(`Message queued during ${event.phase}`, event.preview),
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'message_injected_native':
      return cardRowsBlock({
        keyPrefix,
        label: 'injected',
        value: queueMessageValue('Message delivered to live session', event.preview),
        width: ctx.width,
        labelTone: 'success',
      });
    case 'queue_drained':
      return cardRowsBlock({
        keyPrefix,
        label: 'drained',
        value: `${event.count} queued ${pluralize(event.count, 'message')} folded into next prompt`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'queue_cleared':
      return cardRowsBlock({
        keyPrefix,
        label: 'queue cleared',
        value: `${event.count} pending ${pluralize(event.count, 'message')} removed`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'user_message':
      return wrappedTextBlock({
        keyPrefix,
        text: event.text,
        width: ctx.width,
        tone: 'text',
        bold: true,
      });
    case 'planner_attachments_dropped':
      return cardRowsBlock({
        keyPrefix,
        label: 'attachments dropped',
        value: `${countNoun(event.count, 'image')} dropped (${event.reason})`,
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'warning':
      return calloutRowsBlock({
        keyPrefix,
        label: 'warning',
        value: event.message,
        width: ctx.width,
        severity: 'warning',
      });
    case 'error':
      return calloutRowsBlock({
        keyPrefix,
        label: 'error',
        value: event.message,
        width: ctx.width,
        severity: 'error',
      });
    case 'cost_prediction':
      return rowsBlock(keyPrefix, costPredictionRows(keyPrefix, event, ctx.width));
    case 'budget_warning':
      return calloutRowsBlock({
        keyPrefix,
        label: 'budget',
        value: `80% reached: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        severity: 'warning',
      });
    case 'budget_paused':
      return calloutRowsBlock({
        keyPrefix,
        label: 'budget',
        value: `Paused: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        severity: 'warning',
      });
    case 'budget_exceeded':
      return calloutRowsBlock({
        keyPrefix,
        label: 'budget',
        value: `Exceeded: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        severity: 'error',
      });
    case 'approval_mode_changed':
      return cardRowsBlock({
        keyPrefix,
        label: 'approval',
        value: event.mode === 'yolo' ? 'tiered approvals disabled' : 'tiered approvals restored',
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'runner_call_activity':
      return runnerActivityBatchRowBlock({
        events: [event],
        batchKey: keyPrefix,
        width: ctx.width,
      });
    default:
      return assertNever(event);
  }
}

function plannerTextRowBlock(options: {
  event: EngineEventOf<'planner_text'>;
  keyPrefix: string;
  width: number;
}): ConversationRowBlock | null {
  const { event, keyPrefix, width } = options;
  if (isPlannerTextRenderedAsMarkdown(event)) {
    return markdownPlannerTextRowBlock({
      keyPrefix,
      text: event.text,
      width,
      phase: event.phase,
    });
  }

  switch (event.content) {
    case 'markdown':
      return markdownPlannerTextRowBlock({
        keyPrefix,
        text: event.text,
        width,
        phase: event.phase,
      });
    case 'plain':
    case undefined:
      return wrappedTextBlock({
        keyPrefix,
        text: event.text,
        width,
        tone: plannerTextTone(event.role),
      });
    default:
      return assertNever(event.content);
  }
}

export function isPlannerTextRenderedAsMarkdown(event: EngineEventOf<'planner_text'>): boolean {
  return event.content === 'markdown' || isLiveTaskBriefMarkdown(event);
}

function isLiveTaskBriefMarkdown(event: EngineEventOf<'planner_text'>): boolean {
  if (event.phase !== 'researching') return false;
  if (event.role !== undefined && event.role !== 'planner') return false;
  return looksLikeTaskBriefMarkdown(event.text);
}

function looksLikeTaskBriefMarkdown(text: string): boolean {
  const document = parseMarkdownBlocks(text);
  let hasTaskBriefMetadata = false;
  let hasHeading = false;

  for (const block of document.blocks) {
    if (block.kind === 'frontmatter') {
      hasTaskBriefMetadata =
        hasTaskBriefMetadata || hasTaskBriefMetadataKeys(taskBriefMetadataKeys(block.lines));
    }
    if (block.kind === 'heading') hasHeading = true;
    if (hasTaskBriefMetadata && hasHeading) return true;
  }

  return false;
}

function taskBriefMetadataKeys(lines: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    const key = parseMarkdownYamlKey(line);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function runningImplementerRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_running' }>,
  ctx: RowBuildContext,
): ConversationRowBlock | null {
  const fileHint = event.file ? `generating ${event.file}...` : 'generating...';
  const streamLines =
    ctx.streaming.active && ctx.streaming.taskId === event.taskId
      ? ctx.streaming.lines.slice(0, 5)
      : [];

  return compositeBlock(keyPrefix, [
    wrappedTextBlock({
      keyPrefix: `${keyPrefix}-running-0`,
      text: fileHint,
      width: ctx.width,
      tone: 'textDim',
    }),
    ...streamLines.map((line, index) =>
      wrappedTextBlock({
        keyPrefix: `${keyPrefix}-stream-${index}-${index + 1}`,
        text: line,
        width: ctx.width,
        tone: 'textDim',
      }),
    ),
  ]);
}

function implementerDoneRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_done' }>,
  ctx: RowBuildContext,
  expanded: boolean,
): ConversationRowBlock | null {
  const header = wrappedTextBlock({
    keyPrefix: `${keyPrefix}-header-0`,
    text: `${event.file}  ${formatDuration(event.duration)}`,
    width: ctx.width,
    tone: 'textDim',
  });

  if (!event.diff) {
    return compositeBlock(keyPrefix, [
      header,
      wrappedTextBlock({
        keyPrefix: `${keyPrefix}-summary-1`,
        text: `${event.file} (+${event.linesAdded} -${event.linesRemoved})`,
        width: ctx.width,
        tone: 'textDim',
      }),
    ]);
  }

  const diffLines = sanitizeRowDisplayText(event.diff)
    .split('\n')
    .filter((line) => line.length > 0);
  if (!expanded || diffLines.length === 0) {
    return compositeBlock(keyPrefix, [
      header,
      wrappedTextBlock({
        keyPrefix: `${keyPrefix}-collapsed-1`,
        text: `${event.file} (+${event.linesAdded} -${event.linesRemoved})  ctrl+d`,
        width: ctx.width,
        tone: 'textDim',
      }),
    ]);
  }

  return implementerExpandedDiffCardBlock(keyPrefix, event, ctx);
}

function validateRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'validate' }>,
  width: number,
): ConversationRowBlock | null {
  return compositeBlock(keyPrefix, [
    wrappedTextBlock({
      keyPrefix,
      text: validationRow(event),
      width,
      tone: event.passed ? 'success' : 'textDim',
    }),
    event.status === 'done' && !event.passed && event.error
      ? wrappedTextBlock({
          keyPrefix: `${keyPrefix}-error`,
          text: `error: ${event.error}`,
          width,
          tone: 'error',
        })
      : null,
  ]);
}

function escalateRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'escalate' }>,
  width: number,
): ConversationRowBlock | null {
  return compositeBlock(keyPrefix, [
    wrappedTextBlock({
      keyPrefix,
      text: `escalate tier ${event.tier}${event.hint ? ' — hint' : ''}`,
      width,
      tone: 'textDim',
      bold: true,
    }),
    event.hint
      ? wrappedTextBlock({
          keyPrefix: `${keyPrefix}-hint`,
          text: `hint: ${event.hint}`,
          width,
          tone: 'textDim',
        })
      : null,
  ]);
}

function queueMessageValue(base: string, preview: string | undefined): string {
  return preview ? `${base}: ${preview}` : base;
}

function plannerTextTone(role: EngineEventOf<'planner_text'>['role']): ConversationRowTone {
  return role === undefined ? 'text' : 'textDim';
}

function recoveryResolvedTone(
  outcome: EngineEventOf<'recovery_resolved'>['outcome'],
): ConversationRowTone {
  switch (outcome) {
    case 'continued':
    case 'retry-current-task':
      return 'success';
    case 'skipped-current-task':
      return 'textDim';
    case 'aborted':
      return 'error';
    default:
      return assertNever(outcome);
  }
}
