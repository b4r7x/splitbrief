import { assertNever } from '../../utils/type-guards.js';
import type { DynamicSection } from './event-sections.js';
import type { LayoutEvent } from './event-types.js';
import { getMaxVisibleDiffLines } from './diff-height.js';

export interface RenderableConversationItem<TEvent extends LayoutEvent = LayoutEvent> {
  event: TEvent;
  globalIndex: number;
  height: number;
  leadingSpacer: boolean;
}

const GUTTER_PADDING = 14;
const CHROME_EVENT_TYPES = new Set<LayoutEvent['type']>(['planner_status', 'workflow_config']);

export function isChromeEvent(type: LayoutEvent['type']): boolean {
  return CHROME_EVENT_TYPES.has(type);
}

export function visualLineCount(text: string, width: number): number {
  const effective = Math.max(20, width - GUTTER_PADDING);
  let lines = 0;
  const rawLines = text.split('\n');
  for (const raw of rawLines) {
    const len = raw.length;
    lines += len === 0 ? 1 : Math.ceil(len / effective);
  }
  return lines;
}

function estimateExpandedDiffBodyHeight(diff: string, rows: number): number {
  const maxLines = getMaxVisibleDiffLines(rows);
  const lines = diff.split('\n').filter((line) => line.length > 0);
  const visible = Math.min(lines.length, maxLines);
  const remaining = Math.max(0, lines.length - visible);
  return 1 + visible + (remaining > 0 ? 1 : 0);
}

type HeightCtx = { cols: number; rows: number; diffExpanded: boolean };

function applyHeightRule(event: LayoutEvent, ctx: HeightCtx): number {
  const { cols, rows, diffExpanded } = ctx;
  switch (event.type) {
    case 'workflow_started': return 0;
    case 'workflow_resumed': return 0;
    case 'workflow_complete': return 0;
    case 'workflow_cancelled': return 2;
    case 'planner_status': return 0;
    case 'workflow_config': return 0;
    case 'paused_external_changes': return 1;
    case 'recovery_prompted': return 1;
    case 'recovery_action_selected': return 1;
    case 'recovery_action_failed': return 1;
    case 'recovery_resolved': return 1;
    case 'planner_text': return Math.max(1, visualLineCount(event.text, cols));
    case 'research_done': return 0;
    case 'spec_done': return 0;
    case 'spec_approved': return 0;
    case 'spec_rejected': return 0;
    case 'spec_regenerated': return 0;
    case 'plan_done': return 0;
    case 'plan_approved': return 0;
    case 'plan_rejected': return 0;
    case 'plan_regenerated': return 0;
    case 'rewind_to_spec': return 1;
    case 'rewind_to_plan': return 1;
    case 'all_tasks_done': return 0;
    case 'brief_quality_passed': return 1;
    case 'brief_quality_failed': return 1;
    case 'drift_report': return 1;
    case 'drift_chain_detected': return 0;
    case 'snapshot_created': return 0;
    case 'snapshot_restored': return 0;
    case 'snapshot_restore_conflict': return 0;
    case 'mode_resolved': return 0;
    case 'mode_downgrade_advised': return 1;
    case 'mode_advice': return 0;
    case 'instant_plan_received': return 0;
    case 'task_started': return 1;
    case 'task_completed': return 0;
    case 'task_failed': return 0;
    case 'task_skipped': return 1;
    case 'task_escalating': return 0;
    case 'task_full_fail': return 0;
    case 'task_reset': return 1;
    case 'task_tokens': return 0;
    case 'task_review_needed': return 0;
    case 'hint_failed': return 0;
    case 'implementer_generate_running': return 1;
    case 'implementer_generate_done':
      if (!event.diff) return 2;
      return diffExpanded ? 1 + estimateExpandedDiffBodyHeight(event.diff, rows) : 2;
    case 'implementer_generate_failed': return 1;
    case 'validate':
      if (event.status === 'running') return 1;
      return event.error ? 1 + visualLineCount(event.error, cols - 2) : 1;
    case 'task_retry': return 1;
    case 'escalate': return event.hint ? 1 + visualLineCount(event.hint, cols - 2) : 1;
    case 'git_commit': return 1;
    case 'git_checkpoint': return 1;
    case 'git_branch_created': return 1;
    case 'clarifications_collected': return 0;
    case 'clarification_answered': return 0;
    case 'message_queued': return 1;
    case 'message_injected_native': return 1;
    case 'queue_drained': return 1;
    case 'queue_cleared': return 1;
    case 'user_message': return Math.max(1, visualLineCount(event.text, cols));
    case 'planner_attachment_added': return 1;
    case 'planner_attachments_dropped': return 1;
    case 'warning': return visualLineCount(`warning  ${event.message}`, cols);
    case 'error': return visualLineCount(`error  ${event.message}`, cols);
    case 'cost_update': return 0;
    case 'cost_prediction': return 3;
    case 'budget_warning': return 1;
    case 'budget_paused': return 1;
    case 'budget_exceeded': return 1;
    case 'approval_prompted': return 0;
    case 'approval_granted': return 0;
    case 'approval_rejected': return 0;
    case 'approval_sticky_recorded': return 0;
    case 'approval_mode_changed': return 1;
    case 'ipc_server_started': return 0;
    case 'ipc_client_attached': return 0;
    case 'ipc_client_detached': return 0;
    case 'ipc_reconnect_attempt': return 0;
    case 'ipc_reconnect_failed': return 0;
    case 'server_crash_detected': return 0;
    case 'server_post_mortem_shown': return 0;
    case 'replay_started': return 0;
    case 'replay_complete': return 0;
    default: return assertNever(event);
  }
}

export function estimateEventHeight(event: LayoutEvent, diffExpanded = false, cols = 80, rows = 24): number {
  return applyHeightRule(event, { cols, rows, diffExpanded });
}

export function getRenderableConversationItems<TEvent extends LayoutEvent>(
  sections: DynamicSection<TEvent>[],
  expandedDiffs: Set<number>,
  cols?: number,
  rows?: number,
): RenderableConversationItem<TEvent>[] {
  const items: RenderableConversationItem<TEvent>[] = [];
  for (const section of sections) {
    for (const [index, event] of section.items.entries()) {
      if (isChromeEvent(event.type)) continue;
      const globalIndex = section.startIndex + index;
      const height = estimateEventHeight(event, expandedDiffs.has(globalIndex), cols, rows);
      if (height <= 0) continue;
      items.push({
        event,
        globalIndex,
        height,
        leadingSpacer: items.length > 0,
      });
    }
  }
  return items;
}

export function estimateRenderableConversationHeight(items: RenderableConversationItem[]): number {
  return items.reduce(
    (sum, item) => sum + item.height + (item.leadingSpacer ? 1 : 0),
    0,
  );
}
