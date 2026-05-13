import type { ReactNode } from 'react';
import { Text } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import type { Theme } from '../../../../components/theme.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { Card } from './card.js';

type SimpleCardEvent = Extract<EngineEvent, {
  type:
    | 'workflow_started'
    | 'workflow_resumed'
    | 'workflow_complete'
    | 'research_done'
    | 'spec_done'
    | 'spec_approved'
    | 'spec_rejected'
    | 'spec_regenerated'
    | 'plan_done'
    | 'plan_approved'
    | 'plan_rejected'
    | 'plan_regenerated'
    | 'all_tasks_done'
    | 'planner_heartbeat'
    | 'git_commit'
    | 'git_checkpoint'
    | 'git_branch_created'
    | 'warning'
    | 'error'
    | 'message_queued'
    | 'message_injected_native'
    | 'queue_drained'
    | 'queue_cleared'
    | 'planner_attachment_added'
    | 'planner_attachments_dropped'
    | 'mode_resolved'
    | 'mode_downgrade_advised'
    | 'mode_advice'
    | 'instant_plan_received'
    | 'clarifications_collected'
    | 'clarification_answered'
    | 'brief_quality_passed'
    | 'brief_quality_failed'
    | 'drift_report'
    | 'drift_chain_detected'
    | 'snapshot_created'
    | 'snapshot_restored'
    | 'snapshot_restore_conflict'
    | 'approval_prompted'
    | 'approval_granted'
    | 'approval_rejected'
    | 'approval_sticky_recorded'
    | 'approval_mode_changed'
    | 'ipc_server_started'
    | 'ipc_client_attached'
    | 'ipc_client_detached'
    | 'ipc_reconnect_attempt'
    | 'ipc_reconnect_failed'
    | 'server_crash_detected'
    | 'server_post_mortem_shown'
    | 'replay_started'
    | 'replay_complete';
}>;

export function renderSimpleCard(event: SimpleCardEvent, t: Theme): ReactNode {
  switch (event.type) {
    case 'git_commit':
      return (
        <Card
          label="committed"
          labelColor={t.success}
          value={event.message}
          valueColor={t.textDim}
        />
      );
    case 'git_checkpoint':
      return (
        <Card
          label="checkpoint"
          labelColor={t.success}
          value={event.tag}
          valueColor={t.textDim}
        />
      );
    case 'git_branch_created':
      return (
        <Card
          label="branch"
          labelColor={t.success}
          value={event.name}
          valueColor={t.textDim}
        />
      );
    case 'warning':
      return (
        <Card
          label="warning"
          labelColor={t.warning}
          value={event.message}
          valueColor={t.warning}
        />
      );
    case 'error':
      return (
        <Card
          label="error"
          labelColor={t.error}
          value={event.message}
          valueColor={t.error}
        />
      );
    case 'message_queued':
      return (
        <Card
          label="queued"
          labelColor={t.info}
          value={`Message queued during ${event.phase}`}
          valueColor={t.textDim}
        />
      );
    case 'message_injected_native':
      return (
        <Card
          label="injected"
          labelColor={t.success}
          value="Message delivered to live session"
          valueColor={t.textDim}
        />
      );
    case 'queue_drained':
      return (
        <Card
          label="drained"
          labelColor={t.info}
          value={`${event.count} queued message${event.count === 1 ? '' : 's'} folded into next prompt`}
          valueColor={t.textDim}
        />
      );
    case 'queue_cleared':
      return (
        <Card
          label="queue cleared"
          labelColor={t.warning}
          value={`${event.count} pending message${event.count === 1 ? '' : 's'} removed`}
          valueColor={t.textDim}
        />
      );
    case 'planner_attachment_added':
      return (
        <Card
          label="attached"
          labelColor={t.info}
          value={event.path}
          valueColor={t.textDim}
        />
      );
    case 'planner_attachments_dropped':
      return (
        <Card
          label="attachments dropped"
          labelColor={t.warning}
          value={`${event.count} image${event.count === 1 ? '' : 's'} dropped (${event.reason})`}
          valueColor={t.warning}
        />
      );
    case 'mode_downgrade_advised':
      return (
        <Text color={t.warning}>
          This looks trivial. Consider --mode {event.suggestedMode} instead of --mode {event.currentMode}.
        </Text>
      );
    case 'approval_mode_changed':
      return (
        <Card
          label="approval"
          labelColor={event.mode === 'yolo' ? t.warning : t.textDim}
          value={event.mode === 'yolo' ? 'tiered approvals disabled' : 'tiered approvals restored'}
          valueColor={event.mode === 'yolo' ? t.warning : t.textDim}
        />
      );
    case 'brief_quality_passed':
      return (
        <Card
          label="brief quality"
          labelColor={t.success}
          value={`score ${event.score.toFixed(2)} · ${event.warningCount} warning${event.warningCount === 1 ? '' : 's'}`}
          valueColor={t.textDim}
        />
      );
    case 'brief_quality_failed':
      return (
        <Card
          label="brief quality"
          labelColor={t.error}
          value={`score ${event.score.toFixed(2)} · ${event.errorCount} error${event.errorCount === 1 ? '' : 's'} · ${event.warningCount} warning${event.warningCount === 1 ? '' : 's'}`}
          valueColor={t.error}
        />
      );
    case 'drift_report':
      return (
        <Card
          label="drift"
          labelColor={event.passed ? t.success : t.warning}
          value={`score ${event.score.toFixed(2)} · ${event.errorCount} error${event.errorCount === 1 ? '' : 's'} · ${event.warningCount} warning${event.warningCount === 1 ? '' : 's'}`}
          valueColor={event.passed ? t.textDim : t.warning}
        />
      );
    case 'workflow_started':
    case 'workflow_resumed':
    case 'workflow_complete':
    case 'research_done':
    case 'spec_done':
    case 'spec_approved':
    case 'spec_rejected':
    case 'spec_regenerated':
    case 'plan_done':
    case 'plan_approved':
    case 'plan_rejected':
    case 'plan_regenerated':
    case 'all_tasks_done':
    case 'planner_heartbeat':
    case 'mode_resolved':
    case 'mode_advice':
    case 'instant_plan_received':
    case 'clarifications_collected':
    case 'clarification_answered':
    case 'drift_chain_detected':
    case 'snapshot_created':
    case 'snapshot_restored':
    case 'snapshot_restore_conflict':
    case 'approval_prompted':
    case 'approval_granted':
    case 'approval_rejected':
    case 'approval_sticky_recorded':
    case 'ipc_server_started':
    case 'ipc_client_attached':
    case 'ipc_client_detached':
    case 'ipc_reconnect_attempt':
    case 'ipc_reconnect_failed':
    case 'server_crash_detected':
    case 'server_post_mortem_shown':
    case 'replay_started':
    case 'replay_complete':
      return null;
    default:
      return assertNever(event);
  }
}
