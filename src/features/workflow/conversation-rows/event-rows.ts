import { formatCost, formatScoreSummary } from '../../../core/formatting.js';
import { formatModelName } from '../../../core/model-display.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { formatDuration } from '../../../utils/format-time.js';
import { hasTaskBriefMetadataKeys, parseMarkdownYamlKey } from '../../../utils/markdown/grammar.js';
import { parseMarkdownBlocks } from '../../../utils/markdown/block-parser.js';
import { countNoun, pluralize } from '../../../utils/pluralize.js';
import { assertNever } from '../../../utils/type-guards.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import { costPredictionRows } from './cost-prediction-rows.js';
import {
  formatExternalChangesValue,
  formatTaskStartedValue,
  validationRow,
} from './event-format.js';
import { getMaxVisibleDiffLines } from '../layout/diff-height.js';
import type {
  ConversationRow,
  ConversationRowBlock,
  ConversationRowKind,
  ConversationRowTone,
  RowBuildContext,
} from './types.js';
import {
  cardRowsWindow,
  countWrappedRowTexts,
  row,
  sanitizeRowDisplayText,
  wrappedRowTexts,
  type RowInput,
} from './row-format.js';
import { markdownConversationRowsProjection } from './markdown-rows.js';

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
    case 'runner_call_started':
    case 'runner_call_text_delta':
    case 'runner_call_usage':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
    case 'runner_call_warning':
    case 'runner_call_error':
    case 'runner_call_completed':
    case 'runner_call_tool_use':
      return null;
    case 'workflow_cancelled':
      return rowSeedsBlock(keyPrefix, [
        { key: `${keyPrefix}-title`, text: 'Workflow cancelled', tone: 'warning', bold: true },
      ]);
    case 'paused_external_changes':
      return cardRowsBlock({
        keyPrefix,
        label: 'user edits',
        value: formatExternalChangesValue(event),
        width: ctx.width,
        labelTone: event.conflict?.safeToContinue ? 'warning' : 'error',
      });
    case 'recovery_prompted':
      return cardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `${event.reason}${event.taskId ? ` · ${event.taskId}` : ''} · recommended ${event.recommendedAction}`,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'recovery_action_selected':
      return cardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `selected ${event.action} for ${event.reason}`,
        width: ctx.width,
        labelTone: 'info',
      });
    case 'recovery_action_failed':
      return cardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `${event.action} blocked: ${event.message}`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'error',
      });
    case 'recovery_resolved':
      return cardRowsBlock({
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
        label: 'rewind → spec',
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'warning',
      });
    case 'rewind_to_plan':
      return cardRowsBlock({
        keyPrefix,
        label: 'rewind → plan',
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'warning',
      });
    case 'brief_quality_passed':
      return cardRowsBlock({
        keyPrefix,
        label: 'brief quality',
        value: formatScoreSummary(event.score, { errorCount: 0, warningCount: event.warningCount }),
        width: ctx.width,
        labelTone: 'success',
      });
    case 'brief_quality_failed':
      return cardRowsBlock({
        keyPrefix,
        label: 'brief quality',
        value: formatScoreSummary(event.score, {
          errorCount: event.errorCount,
          warningCount: event.warningCount,
        }),
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'error',
      });
    case 'drift_report':
      return cardRowsBlock({
        keyPrefix,
        label: 'drift',
        value: formatScoreSummary(event.score, {
          errorCount: event.errorCount,
          warningCount: event.warningCount,
        }),
        width: ctx.width,
        labelTone: event.passed ? 'success' : 'warning',
        valueTone: event.passed ? 'textDim' : 'warning',
      });
    case 'mode_downgrade_advised':
      return wrappedTextBlock({
        keyPrefix,
        text: `This looks trivial. Consider --mode ${event.suggestedMode} instead of --mode ${event.currentMode}.`,
        width: ctx.width,
        tone: 'warning',
      });
    case 'task_started':
      return wrappedTextBlock({
        keyPrefix,
        text: `T${event.index + 1}: ${event.title}  ${formatTaskStartedValue(event)}`,
        width: ctx.width,
        tone: 'text',
        bold: true,
        kind: 'task-header',
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
        valueTone: 'error',
        kind: 'summary',
      });
    case 'task_retry':
      return wrappedTextBlock({
        keyPrefix,
        text: `retry  attempt ${event.attempt}/${event.maxRetries}`,
        width: ctx.width,
        tone: 'warning',
      });
    case 'task_reset':
      return cardRowsBlock({
        keyPrefix,
        label: 'task reset',
        value: `Task ${event.taskId} set to pending`,
        width: ctx.width,
        labelTone: 'warning',
      });
    case 'implementer_generate_running':
      return runningImplementerRowBlock(keyPrefix, event, ctx);
    case 'implementer_generate_done':
      return implementerDoneRowBlock(keyPrefix, event, ctx, expanded);
    case 'implementer_generate_failed':
      return wrappedTextBlock({
        keyPrefix,
        text: `${formatModelName(event.model)}  failed`,
        width: ctx.width,
        tone: 'error',
      });
    case 'validate':
      return validateRowBlock(keyPrefix, event, ctx.width);
    case 'escalate':
      return escalateRowBlock(keyPrefix, event, ctx.width);
    case 'git_commit':
      return cardRowsBlock({
        keyPrefix,
        label: 'committed',
        value: event.message,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'git_checkpoint':
      return cardRowsBlock({
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
        labelTone: 'info',
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
        labelTone: 'info',
      });
    case 'queue_cleared':
      return cardRowsBlock({
        keyPrefix,
        label: 'queue cleared',
        value: `${event.count} pending ${pluralize(event.count, 'message')} removed`,
        width: ctx.width,
        labelTone: 'warning',
      });
    case 'user_message':
      return wrappedTextBlock({
        keyPrefix,
        text: `❯ ${event.text}`,
        width: ctx.width,
        tone: 'accent',
        bold: true,
      });
    case 'planner_attachments_dropped':
      return cardRowsBlock({
        keyPrefix,
        label: 'attachments dropped',
        value: `${countNoun(event.count, 'image')} dropped (${event.reason})`,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'warning':
      return cardRowsBlock({
        keyPrefix,
        label: 'warning',
        value: event.message,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'error':
      return cardRowsBlock({
        keyPrefix,
        label: 'error',
        value: event.message,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'error',
      });
    case 'cost_prediction':
      return rowsBlock(keyPrefix, costPredictionRows(keyPrefix, event, ctx.width));
    case 'budget_warning':
      return cardRowsBlock({
        keyPrefix,
        label: 'budget',
        value: `80% reached: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'budget_paused':
      return cardRowsBlock({
        keyPrefix,
        label: 'budget',
        value: `Paused: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'budget_exceeded':
      return cardRowsBlock({
        keyPrefix,
        label: 'budget',
        value: `Exceeded: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'error',
      });
    case 'approval_mode_changed':
      return cardRowsBlock({
        keyPrefix,
        label: 'approval',
        value: event.mode === 'yolo' ? 'tiered approvals disabled' : 'tiered approvals restored',
        width: ctx.width,
        labelTone: event.mode === 'yolo' ? 'warning' : 'textDim',
        valueTone: event.mode === 'yolo' ? 'warning' : 'textDim',
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

function rowsBlock(key: string, rows: readonly ConversationRow[]): ConversationRowBlock | null {
  if (rows.length === 0) return null;
  const safeRows = rows.map((sourceRow) => ({
    ...sourceRow,
    segments: sourceRow.segments.map((segment) => ({
      ...segment,
      text: sanitizeRowDisplayText(segment.text),
    })),
  }));
  return {
    key,
    rowCount: safeRows.length,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) => safeRows.slice(windowStart, windowEnd),
  };
}

function rowSeedsBlock(key: string, seeds: readonly RowInput[]): ConversationRowBlock | null {
  if (seeds.length === 0) return null;
  const safeSeeds = seeds.map((seed) => ({
    ...seed,
    text: sanitizeRowDisplayText(seed.text),
  }));
  return {
    key,
    rowCount: safeSeeds.length,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      safeSeeds.slice(windowStart, windowEnd).map((seed) => row(seed)),
  };
}

function wrappedTextBlock(input: {
  keyPrefix: string;
  text: string;
  width: number;
  tone: ConversationRowTone;
  bold?: boolean;
  kind?: ConversationRowKind;
}): ConversationRowBlock | null {
  const keyPrefix = input.keyPrefix;
  const text = sanitizeRowDisplayText(input.text);
  const width = input.width;
  const tone = input.tone;
  const bold = input.bold;
  const kind = input.kind;
  const rowCount = countEventWrappedRows(text, width);
  if (rowCount === 0) return null;

  return {
    key: keyPrefix,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      eventWrappedRowsWindow({
        keyPrefix,
        text,
        width,
        tone,
        ...(bold !== undefined && { bold }),
        ...(kind !== undefined && { kind }),
        windowStart,
        windowEnd,
      }),
  };
}

function cardRowsBlock(input: {
  keyPrefix: string;
  label: string;
  value: string | undefined;
  width: number;
  labelTone: ConversationRowTone;
  valueTone?: ConversationRowTone;
  kind?: ConversationRowKind;
}): ConversationRowBlock | null {
  const keyPrefix = input.keyPrefix;
  const label = sanitizeRowDisplayText(input.label);
  const value = input.value === undefined ? undefined : sanitizeRowDisplayText(input.value);
  const width = input.width;
  const labelTone = input.labelTone;
  const valueTone = input.valueTone;
  const kind = input.kind;
  const labelText = value ? `${label}  ` : label;
  const rowCount = countWrappedRowTexts(`${labelText}${value ?? ''}`, width);
  if (rowCount === 0) return null;

  return {
    key: keyPrefix,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      cardRowsWindow({
        keyPrefix,
        label,
        value,
        width,
        labelTone,
        ...(valueTone !== undefined && { valueTone }),
        ...(kind !== undefined && { kind }),
        windowStart,
        windowEnd,
      }),
  };
}

function compositeBlock(
  key: string,
  blocks: readonly (ConversationRowBlock | null)[],
): ConversationRowBlock | null {
  const children = blocks.filter((block): block is ConversationRowBlock => block !== null);
  if (children.length === 0) return null;
  const rowCount = children.reduce((count, block) => count + block.rowCount, 0);

  return {
    key,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) => {
      const rows: ConversationRow[] = [];
      const start = Math.max(0, windowStart);
      const end = Math.max(start, windowEnd);
      let cursor = 0;

      for (const block of children) {
        const blockStart = cursor;
        const blockEnd = cursor + block.rowCount;
        cursor = blockEnd;
        if (blockEnd <= start) continue;
        if (blockStart >= end) break;
        rows.push(
          ...block.createRows(
            Math.max(0, start - blockStart),
            Math.min(block.rowCount, end - blockStart),
          ),
        );
      }

      return rows;
    },
  };
}

function countEventWrappedRows(text: string, width: number): number {
  return text
    .split('\n')
    .reduce((count, rawLine) => count + countWrappedRowTexts(rawLine, width), 0);
}

function eventWrappedRowsWindow(input: {
  keyPrefix: string;
  text: string;
  width: number;
  tone: ConversationRowTone;
  bold?: boolean;
  kind?: ConversationRowKind;
  windowStart: number;
  windowEnd: number;
}): ConversationRow[] {
  const rows: ConversationRow[] = [];
  const start = Math.max(0, input.windowStart);
  const end = Math.max(start, input.windowEnd);
  const bold = input.bold ?? false;
  const kind = input.kind ?? 'message';
  let rowIndex = 0;

  for (const rawLine of input.text.split('\n')) {
    for (const wrappedLine of wrappedRowTexts(rawLine, input.width)) {
      if (rowIndex >= start && rowIndex < end) {
        rows.push(
          row({
            key: `${input.keyPrefix}-${rowIndex}`,
            text: wrappedLine,
            tone: input.tone,
            bold,
            kind,
          }),
        );
      }
      rowIndex += 1;
      if (rowIndex >= end) return rows;
    }
  }

  return rows;
}

function plannerTextRowBlock(options: {
  event: EngineEventOf<'planner_text'>;
  keyPrefix: string;
  width: number;
}): ConversationRowBlock | null {
  const { event, keyPrefix, width } = options;
  if (isPlannerTextRenderedAsMarkdown(event)) {
    return markdownPlannerTextRowBlock({ keyPrefix, text: event.text, width });
  }

  switch (event.content) {
    case 'markdown':
      return markdownPlannerTextRowBlock({ keyPrefix, text: event.text, width });
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

function markdownPlannerTextRowBlock(input: {
  keyPrefix: string;
  text: string;
  width: number;
}): ConversationRowBlock | null {
  const projection = markdownConversationRowsProjection(input);
  if (projection.rowCount === 0) return null;
  return {
    key: input.keyPrefix,
    rowCount: projection.rowCount,
    renderableUnits: 1,
    createRows: projection.createRows,
  };
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
      tone: 'implementer',
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
    tone: 'implementer',
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
        text: `▸ ${event.file} (+${event.linesAdded} -${event.linesRemoved})  Ctrl+D`,
        width: ctx.width,
        tone: 'textDim',
      }),
    ]);
  }

  const maxLines = getMaxVisibleDiffLines(ctx.viewportRows);
  const visibleLines = diffLines.slice(0, maxLines);
  const remaining = diffLines.length - visibleLines.length;

  return compositeBlock(keyPrefix, [
    header,
    wrappedTextBlock({
      keyPrefix: `${keyPrefix}-expanded-1`,
      text: `▾ ${event.file} (+${event.linesAdded} -${event.linesRemoved})  Ctrl+D`,
      width: ctx.width,
      tone: 'textDim',
    }),
    ...visibleLines.map((line, index) =>
      wrappedTextBlock({
        keyPrefix: `${keyPrefix}-diff-${index}-${index + 2}`,
        text: `${String(index + 1).padStart(3, '0')} ${line}`,
        width: ctx.width,
        tone: diffLineTone(line),
      }),
    ),
    remaining > 0
      ? wrappedTextBlock({
          keyPrefix: `${keyPrefix}-remaining-${visibleLines.length + 2}`,
          text: `...${remaining} more lines`,
          width: ctx.width,
          tone: 'textDim',
        })
      : null,
  ]);
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
      tone: event.passed ? 'success' : 'validator',
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
      tone: 'planner',
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
  switch (role) {
    case 'implementer':
      return 'implementer';
    case 'planner':
      return 'planner';
    case undefined:
      return 'text';
    default:
      return assertNever(role);
  }
}

function recoveryResolvedTone(
  outcome: EngineEventOf<'recovery_resolved'>['outcome'],
): ConversationRowTone {
  switch (outcome) {
    case 'continued':
    case 'retry-current-task':
      return 'success';
    case 'skipped-current-task':
      return 'warning';
    case 'aborted':
      return 'error';
    default:
      return assertNever(outcome);
  }
}

function diffLineTone(line: string): ConversationRowTone {
  if (line.startsWith('+ ')) return 'success';
  if (line.startsWith('- ')) return 'error';
  return 'textDim';
}
