import type { ReactNode } from "react";
import { Box, Text } from "ink";
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { useTheme } from "../../../../components/theme.js";
import { MarkdownBlock } from "../../../../components/markdown.js";
import { formatCost } from "../../../../core/formatting.js";
import { formatToolModel } from "../../../../core/model-display.js";
import { phaseRole } from "../../../../core/phases.js";
import { assertNever } from "../../../../utils/type-guards.js";
import { Card } from "./card.js";
import { ImplementerCard } from "./implementer-card.js";
import { ValidateCard } from "./validate-card.js";
import { PlannerStatusCard } from "./planner-status-card.js";
import { CostPredictionCard } from "./cost-prediction-card.js";
import { WorkflowConfigCard } from "./workflow-config-card.js";
import { EscalateCard } from "./escalate-card.js";
import { UserMessageCard } from "./user-message-card.js";

interface EventCardProps {
  event: EngineEvent;
  diffExpanded?: boolean;
}

function formatExternalChangesValue(event: EngineEventOf<"paused_external_changes">): string {
  if (!event.conflict) {
    return event.selectedAction
      ? `External changes detected · ${event.selectedAction}`
      : "External changes detected";
  }

  const files = event.conflict.files.slice(0, 3).join(", ");
  const hiddenCount = event.conflict.files.length - 3;
  const filesLabel = hiddenCount > 0
    ? `${files}, +${hiddenCount} more`
    : files || "no files";
  const tasksLabel = event.conflict.affectedTaskIds.length > 0
    ? ` · tasks ${event.conflict.affectedTaskIds.join(", ")}`
    : "";
  const actionLabel = event.selectedAction ? ` · ${event.selectedAction}` : "";

  return `${event.conflict.kind} · ${filesLabel}${tasksLabel}${actionLabel}`;
}

function formatTaskStartedValue(event: EngineEventOf<"task_started">): string {
  const parts = [`${event.file} (${event.action})`];
  const toolLabel = formatToolModel(event.tool, event.model);
  if (toolLabel) parts.push(toolLabel);
  if (event.implementerProfile) parts.push(`profile ${event.implementerProfile}`);
  if (event.contextFit) {
    const tokenLabel = event.contextLength === undefined
      ? `${event.estimatedTokens ?? "?"} tok`
      : `${event.estimatedTokens ?? "?"}/${event.contextLength} tok`;
    parts.push(`fit ${event.contextFit} ${tokenLabel}`);
  }
  if (event.currentCodeContextMode && event.currentCodeContextMode !== "none") {
    parts.push(`code ${event.currentCodeContextMode}`);
  }
  if (event.costPosture) parts.push(`cost ${event.costPosture}`);

  return parts.join(" · ");
}

function getGutterRole(event: EngineEvent): "planner" | "implementer" | null {
  switch (event.type) {
    case "planner_status": return phaseRole(event.phase);
    case "planner_text": case "task_started": case "escalate": return "planner";
    case "implementer_generate_running": case "implementer_generate_done":
    case "implementer_generate_failed": case "validate":
    case "git_commit": case "git_checkpoint": case "git_branch_created": case "task_retry": return "implementer";
    case "warning": case "error": case "task_completed": case "task_skipped":
    case "cost_update": case "cost_prediction": case "budget_warning":
    case "budget_paused": case "budget_exceeded": case "workflow_cancelled": case "workflow_config":
    case "rewind_to_spec": case "rewind_to_plan": case "task_reset":
    case "task_review_needed":
    case "message_queued": case "message_injected_native":
    case "queue_drained": case "queue_cleared":
    case "user_message":
    case "planner_attachment_added": case "planner_attachments_dropped":
    case "workflow_started": case "workflow_resumed": case "workflow_complete":
    case "paused_external_changes":
    case "recovery_prompted":
    case "recovery_action_selected":
    case "recovery_action_failed":
    case "recovery_resolved":
    case "research_done": case "spec_done": case "spec_approved": case "spec_rejected":
    case "spec_regenerated": case "plan_done": case "plan_approved": case "plan_rejected":
    case "plan_regenerated": case "all_tasks_done":
    case "task_failed": case "task_escalating": case "task_full_fail":
    case "task_tokens": case "hint_failed":
    case "mode_resolved": case "mode_downgrade_advised": case "mode_advice": case "instant_plan_received":
    case "clarifications_collected": case "clarification_answered":
    case "brief_quality_passed": case "brief_quality_failed":
    case "drift_report":
    case "drift_chain_detected":
    case "snapshot_created":
    case "snapshot_restored":
    case "snapshot_restore_conflict":
    case "approval_prompted":
    case "approval_granted":
    case "approval_rejected":
    case "approval_sticky_recorded":
    case "approval_mode_changed":
    case "ipc_server_started":
    case "ipc_client_attached":
    case "ipc_client_detached":
    case "ipc_reconnect_attempt":
    case "ipc_reconnect_failed":
    case "server_crash_detected":
    case "server_post_mortem_shown":
    case "replay_started":
    case "replay_complete": return null;
    default: return assertNever(event);
  }
}

export function EventCard({ event, diffExpanded = false }: EventCardProps) {
  const t = useTheme();
  let content: ReactNode;

  switch (event.type) {
    case "planner_status":
      content = <PlannerStatusCard event={event} />;
      break;
    case "planner_text":
      content = <MarkdownBlock text={event.text} />;
      break;
    case "task_started": {
      content = (
        <Card
          label={
            <Text bold>
              T{event.index + 1}: {event.title}
            </Text>
          }
          labelColor={t.text}
          value={formatTaskStartedValue(event)}
          valueColor={t.textDim}
        />
      );
      break;
    }
    case "task_completed":
      content = null;
      break;
    case "task_skipped":
      content = (
        <Card
          label="skipped"
          labelColor={t.textDim}
          value={`T${event.taskId} ${event.title}: ${event.reason}`}
          valueColor={t.textDim}
        />
      );
      break;
    case "implementer_generate_running":
    case "implementer_generate_done":
    case "implementer_generate_failed":
      content = <ImplementerCard event={event} diffExpanded={diffExpanded} />;
      break;
    case "validate":
      content = <ValidateCard event={event} />;
      break;
    case "task_retry":
      content = (
        <Card
          label="retry"
          labelColor={t.warning}
          value={`attempt ${event.attempt}/${event.maxRetries}`}
          valueColor={t.textDim}
        />
      );
      break;
    case "escalate":
      content = <EscalateCard event={event} />;
      break;
    case "git_commit":
      content = (
        <Card
          label="committed"
          labelColor={t.success}
          value={event.message}
          valueColor={t.textDim}
        />
      );
      break;
    case "git_checkpoint":
      content = (
        <Card
          label="checkpoint"
          labelColor={t.success}
          value={event.tag}
          valueColor={t.textDim}
        />
      );
      break;
    case "git_branch_created":
      content = (
        <Card
          label="branch"
          labelColor={t.success}
          value={event.name}
          valueColor={t.textDim}
        />
      );
      break;
    case "warning":
      content = (
        <Card
          label="warning"
          labelColor={t.warning}
          value={event.message}
          valueColor={t.warning}
        />
      );
      break;
    case "error":
      content = (
        <Card
          label="error"
          labelColor={t.error}
          value={event.message}
          valueColor={t.error}
        />
      );
      break;
    case "cost_update":
      content = null;
      break;
    case "cost_prediction":
      content = <CostPredictionCard event={event} />;
      break;
    case "budget_warning":
      content = (
        <Card
          label="budget"
          labelColor={t.warning}
          value={`80% reached: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`}
          valueColor={t.warning}
        />
      );
      break;
    case "budget_paused":
      content = (
        <Card
          label="budget"
          labelColor={t.warning}
          value={`Paused: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`}
          valueColor={t.warning}
        />
      );
      break;
    case "budget_exceeded":
      content = (
        <Card
          label="budget"
          labelColor={t.error}
          value={`Exceeded: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`}
          valueColor={t.error}
        />
      );
      break;
    case "workflow_cancelled":
      content = (
        <Box flexDirection="column">
          <Text color={t.warning} bold>
            Workflow cancelled
          </Text>
          <Text color={t.textDim}>
            Resume with: <Text color={t.text}>diptych resume</Text>
          </Text>
        </Box>
      );
      break;
    case "workflow_config":
      content = <WorkflowConfigCard event={event} />;
      break;
    case "rewind_to_spec":
      content = (
        <Card
          label="rewind → spec"
          labelColor={t.warning}
          value={event.comment || undefined}
          valueColor={t.textDim}
        />
      );
      break;
    case "rewind_to_plan":
      content = (
        <Card
          label="rewind → plan"
          labelColor={t.warning}
          value={event.comment || undefined}
          valueColor={t.textDim}
        />
      );
      break;
    case "task_reset":
      content = (
        <Card
          label="task reset"
          labelColor={t.warning}
          value={`Task ${event.taskId} set to pending`}
          valueColor={t.textDim}
        />
      );
      break;
    case "message_queued":
      content = (
        <Card
          label="queued"
          labelColor={t.info}
          value={`Message queued during ${event.phase}`}
          valueColor={t.textDim}
        />
      );
      break;
    case "message_injected_native":
      content = (
        <Card
          label="injected"
          labelColor={t.success}
          value="Message delivered to live session"
          valueColor={t.textDim}
        />
      );
      break;
    case "queue_drained":
      content = (
        <Card
          label="drained"
          labelColor={t.info}
          value={`${event.count} queued message${event.count === 1 ? '' : 's'} folded into next prompt`}
          valueColor={t.textDim}
        />
      );
      break;
    case "queue_cleared":
      content = (
        <Card
          label="queue cleared"
          labelColor={t.warning}
          value={`${event.count} pending message${event.count === 1 ? '' : 's'} removed`}
          valueColor={t.textDim}
        />
      );
      break;
    case "user_message":
      content = <UserMessageCard event={event} />;
      break;
    case "planner_attachment_added":
      content = (
        <Card
          label="attached"
          labelColor={t.info}
          value={event.path}
          valueColor={t.textDim}
        />
      );
      break;
    case "planner_attachments_dropped":
      content = (
        <Card
          label="attachments dropped"
          labelColor={t.warning}
          value={`${event.count} image${event.count === 1 ? '' : 's'} dropped (${event.reason})`}
          valueColor={t.warning}
        />
      );
      break;
    case "mode_downgrade_advised":
      content = (
        <Text color={t.warning}>This looks trivial. Consider --mode {event.suggestedMode} instead of --mode {event.currentMode}.</Text>
      );
      break;
    case "paused_external_changes":
      content = (
        <Card
          label="user edits"
          labelColor={event.conflict?.safeToContinue ? t.warning : t.error}
          value={formatExternalChangesValue(event)}
          valueColor={event.conflict?.safeToContinue ? t.textDim : t.error}
        />
      );
      break;
    case "recovery_prompted":
      content = (
        <Card
          label="recovery"
          labelColor={t.warning}
          value={`${event.reason}${event.taskId ? ` · ${event.taskId}` : ""} · recommended ${event.recommendedAction}`}
          valueColor={t.warning}
        />
      );
      break;
    case "recovery_action_selected":
      content = (
        <Card
          label="recovery"
          labelColor={t.info}
          value={`selected ${event.action} for ${event.reason}`}
          valueColor={t.textDim}
        />
      );
      break;
    case "recovery_action_failed":
      content = (
        <Card
          label="recovery"
          labelColor={t.error}
          value={`${event.action} blocked: ${event.message}`}
          valueColor={t.error}
        />
      );
      break;
    case "recovery_resolved":
      content = (
        <Card
          label="recovery"
          labelColor={t.success}
          value={`${event.outcome} via ${event.action}${event.implementerProfile ? ` · ${event.implementerProfile}` : ""}`}
          valueColor={t.textDim}
        />
      );
      break;
    case "workflow_started":
    case "workflow_resumed":
    case "workflow_complete":
    case "research_done":
    case "spec_done":
    case "spec_approved":
    case "spec_rejected":
    case "spec_regenerated":
    case "plan_done":
    case "plan_approved":
    case "plan_rejected":
    case "plan_regenerated":
    case "all_tasks_done":
    case "task_failed":
    case "task_escalating":
    case "task_full_fail":
    case "task_tokens":
    case "task_review_needed":
    case "hint_failed":
    case "mode_resolved":
    case "mode_advice":
    case "instant_plan_received":
    case "clarifications_collected":
    case "clarification_answered":
      content = null;
      break;
    case "approval_mode_changed":
      content = (
        <Card
          label="approval"
          labelColor={event.mode === "yolo" ? t.warning : t.textDim}
          value={event.mode === "yolo" ? "YOLO mode enabled" : "approval gates restored"}
          valueColor={event.mode === "yolo" ? t.warning : t.textDim}
        />
      );
      break;
    case "snapshot_created":
    case "snapshot_restored":
    case "snapshot_restore_conflict":
    case "approval_prompted":
    case "approval_granted":
    case "approval_rejected":
    case "approval_sticky_recorded":
    case "ipc_server_started":
    case "ipc_client_attached":
    case "ipc_client_detached":
    case "ipc_reconnect_attempt":
    case "ipc_reconnect_failed":
    case "server_crash_detected":
    case "server_post_mortem_shown":
    case "replay_started":
    case "replay_complete":
      content = null;
      break;
    case "brief_quality_passed":
      content = (
        <Card
          label="brief quality"
          labelColor={t.success}
          value={`score ${event.score.toFixed(2)} · ${event.warningCount} warning${event.warningCount === 1 ? '' : 's'}`}
          valueColor={t.textDim}
        />
      );
      break;
    case "brief_quality_failed":
      content = (
        <Card
          label="brief quality"
          labelColor={t.error}
          value={`score ${event.score.toFixed(2)} · ${event.errorCount} error${event.errorCount === 1 ? '' : 's'} · ${event.warningCount} warning${event.warningCount === 1 ? '' : 's'}`}
          valueColor={t.error}
        />
      );
      break;
    case "drift_report":
      content = (
        <Card
          label="drift"
          labelColor={event.passed ? t.success : t.warning}
          value={`score ${event.score.toFixed(2)} · ${event.errorCount} error${event.errorCount === 1 ? '' : 's'} · ${event.warningCount} warning${event.warningCount === 1 ? '' : 's'}`}
          valueColor={event.passed ? t.textDim : t.warning}
        />
      );
      break;
    case "drift_chain_detected":
      content = null;
      break;
    default:
      return assertNever(event);
  }

  if (!content) return null;

  const role = getGutterRole(event);
  if (!role) return <>{content}</>;
  const color = role === "implementer" ? t.implementer : t.planner;
  const char = role === "implementer" ? "┆" : "│";
  const indent = role === "implementer" ? "  " : "";
  return (
    <Box flexDirection="row">
      <Text color={color}>
        {indent}
        {char}{" "}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {content}
      </Box>
    </Box>
  );
}
