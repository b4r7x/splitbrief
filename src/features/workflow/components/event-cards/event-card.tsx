import type { ReactNode } from "react";
import { Box, Text } from "ink";
import type { TuiEvent } from '../../types.js';
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
  event: TuiEvent;
  diffExpanded?: boolean;
}

function getGutterRole(event: TuiEvent): "planner" | "implementer" | null {
  switch (event.type) {
    case "planner-status": return phaseRole(event.phase);
    case "planner-text": case "task-start": case "escalate": return "planner";
    case "implementer-generate-running": case "implementer-generate-done":
    case "implementer-generate-failed": case "validate":
    case "git-commit": case "git-checkpoint": case "retry": return "implementer";
    case "warning": case "error": case "task-complete": case "task-skipped":
    case "cost-update": case "cost-prediction": case "budget-warning":
    case "budget-exceeded": case "workflow-cancelled": case "workflow-config":
    case "rewind": case "task-reset":
    case "message-queued": case "message-injected-native":
    case "queue-drained": case "queue-cleared":
    case "user-message": return null;
    default: return assertNever(event);
  }
}

export function EventCard({ event, diffExpanded = false }: EventCardProps) {
  const t = useTheme();
  let content: ReactNode;

  switch (event.type) {
    case "planner-status":
      content = <PlannerStatusCard event={event} />;
      break;
    case "planner-text":
      content = <MarkdownBlock text={event.text} />;
      break;
    case "task-start": {
      const toolLabel = formatToolModel(event.tool, event.model);
      const value = toolLabel
        ? `${event.file} (${event.action}) · ${toolLabel}`
        : `${event.file} (${event.action})`;
      content = (
        <Card
          label={
            <Text bold>
              T{event.index + 1}: {event.title}
            </Text>
          }
          labelColor={t.text}
          value={value}
          valueColor={t.textDim}
        />
      );
      break;
    }
    case "task-complete":
      content = null;
      break;
    case "task-skipped":
      content = (
        <Card
          label="skipped"
          labelColor={t.textDim}
          value={`T${event.taskId} ${event.title}: ${event.reason}`}
          valueColor={t.textDim}
        />
      );
      break;
    case "implementer-generate-running":
    case "implementer-generate-done":
    case "implementer-generate-failed":
      content = <ImplementerCard event={event} diffExpanded={diffExpanded} />;
      break;
    case "validate":
      content = <ValidateCard event={event} />;
      break;
    case "retry":
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
    case "git-commit":
      content = (
        <Card
          label="committed"
          labelColor={t.success}
          value={event.message}
          valueColor={t.textDim}
        />
      );
      break;
    case "git-checkpoint":
      content = (
        <Card
          label="checkpoint"
          labelColor={t.success}
          value={event.tag}
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
    case "cost-update":
      content = null;
      break;
    case "cost-prediction":
      content = <CostPredictionCard event={event} />;
      break;
    case "budget-warning":
      content = (
        <Card
          label="budget"
          labelColor={t.warning}
          value={`80% reached: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`}
          valueColor={t.warning}
        />
      );
      break;
    case "budget-exceeded":
      content = (
        <Card
          label="budget"
          labelColor={t.error}
          value={`Exceeded: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`}
          valueColor={t.error}
        />
      );
      break;
    case "workflow-cancelled":
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
    case "workflow-config":
      content = <WorkflowConfigCard event={event} />;
      break;
    case "rewind":
      content = (
        <Card
          label={`rewind → ${event.target}`}
          labelColor={t.warning}
          value={event.comment || undefined}
          valueColor={t.textDim}
        />
      );
      break;
    case "task-reset":
      content = (
        <Card
          label="task reset"
          labelColor={t.warning}
          value={`Task ${event.taskId} set to pending`}
          valueColor={t.textDim}
        />
      );
      break;
    case "message-queued":
      content = (
        <Card
          label="queued"
          labelColor={t.info}
          value={`Message queued during ${event.phase}`}
          valueColor={t.textDim}
        />
      );
      break;
    case "message-injected-native":
      content = (
        <Card
          label="injected"
          labelColor={t.success}
          value="Message delivered to live session"
          valueColor={t.textDim}
        />
      );
      break;
    case "queue-drained":
      content = (
        <Card
          label="drained"
          labelColor={t.info}
          value={`${event.count} queued message${event.count === 1 ? '' : 's'} folded into next prompt`}
          valueColor={t.textDim}
        />
      );
      break;
    case "queue-cleared":
      content = (
        <Card
          label="queue cleared"
          labelColor={t.warning}
          value={`${event.count} pending message${event.count === 1 ? '' : 's'} removed`}
          valueColor={t.textDim}
        />
      );
      break;
    case "user-message":
      content = <UserMessageCard event={event} />;
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
