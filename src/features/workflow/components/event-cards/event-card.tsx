import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { useTheme, type Theme } from '../../../../components/theme.js';
import { MarkdownBlock } from '../../../../components/markdown.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { ImplementerCard } from './implementer-card.js';
import { ValidateCard } from './validate-card.js';
import { PlannerStatusCard } from './planner-status-card.js';
import { WorkflowConfigCard } from './workflow-config-card.js';
import { EscalateCard } from './escalate-card.js';
import { UserMessageCard } from './user-message-card.js';
import { getGutterRole } from './event-role.js';
import { renderSimpleCard } from './simple-cards.js';
import { renderTaskCard } from './task-cards.js';
import { renderCostCard } from './cost-cards.js';
import { renderRecoveryCard } from './recovery-cards.js';

interface EventCardProps {
  event: EngineEvent;
  diffExpanded?: boolean;
}

function renderEventContent(event: EngineEvent, diffExpanded: boolean, t: Theme): ReactNode {
  switch (event.type) {
    case 'workflow_started': case 'workflow_resumed': case 'workflow_complete':
    case 'spec_rejected':
    case 'spec_regenerated': case 'plan_approved': case 'plan_rejected':
    case 'plan_regenerated': case 'all_tasks_done': case 'planner_heartbeat':
    case 'git_commit': case 'git_checkpoint': case 'git_branch_created':
    case 'warning': case 'error':
    case 'message_queued': case 'message_injected_native': case 'queue_drained': case 'queue_cleared':
    case 'planner_attachments_dropped':
    case 'mode_resolved': case 'mode_downgrade_advised': case 'mode_advice': case 'instant_plan_received':
    case 'clarifications_collected': case 'clarification_answered':
    case 'brief_quality_passed': case 'brief_quality_failed':
    case 'drift_report': case 'drift_chain_detected':
    case 'snapshot_created': case 'snapshot_restored': case 'snapshot_restore_conflict':
    case 'approval_prompted': case 'approval_granted': case 'approval_rejected':
    case 'approval_sticky_recorded': case 'approval_mode_changed':
    case 'ipc_server_started': case 'ipc_client_attached': case 'ipc_client_detached':
    case 'ipc_reconnect_attempt': case 'ipc_reconnect_failed':
    case 'replay_started': case 'replay_complete':
      return renderSimpleCard(event, t);
    case 'task_started': case 'task_completed': case 'task_skipped': case 'task_retry':
    case 'task_escalating': case 'task_full_fail':
    case 'task_tokens': case 'task_review_needed': case 'hint_failed':
      return renderTaskCard(event, t);
    case 'cost_update': case 'cost_prediction': case 'budget_warning':
    case 'budget_paused': case 'budget_exceeded':
      return renderCostCard(event, t);
    case 'paused_external_changes': case 'recovery_prompted': case 'recovery_action_selected':
    case 'recovery_action_failed': case 'recovery_resolved':
    case 'rewind_to_spec': case 'rewind_to_plan': case 'task_reset':
      return renderRecoveryCard(event, t);
    case 'planner_status':
      return <PlannerStatusCard event={event} />;
    case 'planner_text':
      return <MarkdownBlock text={event.text} />;
    case 'implementer_generate_running':
    case 'implementer_generate_done':
    case 'implementer_generate_failed':
      return <ImplementerCard event={event} diffExpanded={diffExpanded} />;
    case 'validate':
      return <ValidateCard event={event} />;
    case 'escalate':
      return <EscalateCard event={event} />;
    case 'workflow_cancelled':
      return (
        <Box flexDirection="column">
          <Text color={t.warning} bold>
            Workflow cancelled
          </Text>
          <Text color={t.textDim}>
            Resume with: <Text color={t.text}>diptych resume</Text>
          </Text>
        </Box>
      );
    case 'workflow_config':
      return <WorkflowConfigCard event={event} />;
    case 'user_message':
      return <UserMessageCard event={event} />;
    default:
      return assertNever(event);
  }
}

export function EventCard({ event, diffExpanded = false }: EventCardProps) {
  const t = useTheme();
  const content = renderEventContent(event, diffExpanded, t);
  if (!content) return null;

  const role = getGutterRole(event);
  if (!role) return <>{content}</>;
  const color = role === 'implementer' ? t.implementer : t.planner;
  const char = role === 'implementer' ? '┆' : '│';
  const indent = role === 'implementer' ? '  ' : '';
  return (
    <Box flexDirection="row">
      <Text color={color}>
        {indent}
        {char}{' '}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {content}
      </Box>
    </Box>
  );
}
