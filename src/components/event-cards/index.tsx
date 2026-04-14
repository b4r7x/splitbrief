import type { ReactNode } from "react";
import { Box, Text } from "ink";
import type { TuiEvent } from "../../types.js";
import type { Theme } from "../../ui/theme.js";
import { useTheme } from "../../ui/theme.js";
import { MarkdownBlock } from "../../ui/markdown.js";
import { formatCost } from "../../utils/format.js";
import { formatToolModel } from "../../core/model-display.js";
import { phaseRole } from "../../core/phases.js";
import { assertNever } from "../../utils/type-guards.js";
import { Card } from "./card.js";
import {
  ImplementerCard,
  type ImplementerGenerateEvent,
} from "./implementer-card.js";
import { ValidateCard } from "./validate-card.js";
import { PlannerStatusCard } from "./planner-status-card.js";
import { CostPredictionCard } from "./cost-prediction-card.js";
import { WorkflowConfigCard } from "./workflow-config-card.js";
import { EscalateCard } from "./escalate-card.js";

interface EventCardProps {
  event: TuiEvent;
  diffExpanded?: boolean;
}

type RenderCtx = {
  t: Theme;
  diffExpanded: boolean;
};

type EventRenderer<K extends TuiEvent["type"]> = (
  e: Extract<TuiEvent, { type: K }>,
  ctx: RenderCtx,
) => ReactNode;

const implementerRenderer = (
  e: ImplementerGenerateEvent,
  { diffExpanded }: RenderCtx,
) => <ImplementerCard event={e} diffExpanded={diffExpanded} />;

const RENDERERS: { [K in TuiEvent["type"]]: EventRenderer<K> } = {
  "planner-status": (e) => <PlannerStatusCard event={e} />,
  "planner-text": (e) => <MarkdownBlock text={e.text} />,
  "task-start": (e, { t }) => {
    const toolLabel = formatToolModel(e.tool, e.model);
    const value = toolLabel
      ? `${e.file} (${e.action}) · ${toolLabel}`
      : `${e.file} (${e.action})`;
    return (
      <Card
        label={
          <Text bold>
            T{e.index + 1}: {e.title}
          </Text>
        }
        labelColor={t.text}
        value={value}
        valueColor={t.textDim}
      />
    );
  },
  "task-complete": () => null,
  "task-skipped": (e, { t }) => (
    <Card
      label="skipped"
      labelColor={t.textDim}
      value={`T${e.taskId} ${e.title}: ${e.reason}`}
      valueColor={t.textDim}
    />
  ),
  "implementer-generate-running": implementerRenderer,
  "implementer-generate-done": implementerRenderer,
  "implementer-generate-failed": implementerRenderer,
  validate: (e) => <ValidateCard event={e} />,
  retry: (e, { t }) => (
    <Card
      label="retry"
      labelColor={t.warning}
      value={`attempt ${e.attempt}/${e.maxRetries}`}
      valueColor={t.textDim}
    />
  ),
  escalate: (e) => <EscalateCard event={e} />,
  "git-commit": (e, { t }) => (
    <Card
      label="committed"
      labelColor={t.success}
      value={e.message}
      valueColor={t.textDim}
    />
  ),
  "git-checkpoint": (e, { t }) => (
    <Card
      label="checkpoint"
      labelColor={t.success}
      value={e.tag}
      valueColor={t.textDim}
    />
  ),
  warning: (e, { t }) => (
    <Card
      label="warning"
      labelColor={t.warning}
      value={e.message}
      valueColor={t.warning}
    />
  ),
  error: (e, { t }) => (
    <Card
      label="error"
      labelColor={t.error}
      value={e.message}
      valueColor={t.error}
    />
  ),
  "cost-update": () => null,
  "cost-prediction": (e) => <CostPredictionCard event={e} />,
  "budget-warning": (e, { t }) => (
    <Card
      label="budget"
      labelColor={t.warning}
      value={`80% reached: ${formatCost(e.currentCost)} of ${formatCost(e.maxBudget)} limit`}
      valueColor={t.warning}
    />
  ),
  "budget-exceeded": (e, { t }) => (
    <Card
      label="budget"
      labelColor={t.error}
      value={`Exceeded: ${formatCost(e.currentCost)} of ${formatCost(e.maxBudget)} limit`}
      valueColor={t.error}
    />
  ),
  "workflow-cancelled": (_, { t }) => (
    <Box flexDirection="column">
      <Text color={t.warning} bold>
        Workflow cancelled
      </Text>
      <Text color={t.textDim}>
        Resume with: <Text color={t.text}>tiny-spec resume</Text>
      </Text>
    </Box>
  ),
  "workflow-config": (e) => <WorkflowConfigCard event={e} />,
};

function getGutterRole(event: TuiEvent): "planner" | "implementer" | null {
  switch (event.type) {
    case "planner-status": return phaseRole(event.phase);
    case "planner-text": case "task-start": case "escalate": return "planner";
    case "implementer-generate-running": case "implementer-generate-done":
    case "implementer-generate-failed": case "validate":
    case "git-commit": case "git-checkpoint": case "retry": return "implementer";
    case "warning": case "error": case "task-complete": case "task-skipped":
    case "cost-update": case "cost-prediction": case "budget-warning":
    case "budget-exceeded": case "workflow-cancelled": case "workflow-config": return null;
    default: return assertNever(event);
  }
}

function renderEvent(event: TuiEvent, ctx: RenderCtx): ReactNode {
  const renderer = RENDERERS[event.type] as EventRenderer<typeof event.type>;
  return renderer(event, ctx);
}

export function EventCard({ event, diffExpanded }: EventCardProps) {
  const t = useTheme();
  const ctx: RenderCtx = { t, diffExpanded: diffExpanded ?? false };
  const content = renderEvent(event, ctx);
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
