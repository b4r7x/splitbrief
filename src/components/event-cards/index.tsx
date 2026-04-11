import React from "react";
import { Box, Text } from "ink";
import type { TuiEvent } from "../../types.js";
import type { Theme } from "../../ui/theme.js";
import { useTheme } from "../../ui/theme.js";
import { MarkdownBlock } from "../../ui/markdown.js";
import { Spinner } from "../../ui/spinner.js";
import {
  formatDuration,
  formatCost,
  formatToolModel,
} from "../../utils/format.js";
import { phaseRole } from "../../core/phases.js";
import { assertNever } from "../../utils/type-guards.js";
import { getProviderDisplayName } from "../../core/providers/catalog.js";
import { Card } from "./card.js";
import {
  ImplementerCard,
  type ImplementerGenerateEvent,
} from "./implementer-card.js";
import { ValidateCard } from "./validate-card.js";

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
) => React.ReactNode;

const implementerRenderer = (
  e: ImplementerGenerateEvent,
  { diffExpanded }: RenderCtx,
) => <ImplementerCard event={e} diffExpanded={diffExpanded} />;

const RENDERERS: { [K in TuiEvent["type"]]: EventRenderer<K> } = {
  "planner-status": (e, { t }) => {
    const role = phaseRole(e.phase);
    const color = role === "implementer" ? t.implementer : t.planner;
    const toolLabel = formatToolModel(e.tool, e.model);
    if (e.status === "running") {
      const suffix = toolLabel ? ` (${toolLabel})` : "";
      return (
        <Spinner
          label={`${role}  ${e.phase}${suffix}...`}
          color={color}
          startTime={e.ts}
        />
      );
    }
    const dur = e.duration ? ` ${formatDuration(e.duration)}` : "";
    return (
      <Text>
        <Text color={color}>{role}</Text>
        <Text color={t.success}> ✓ {e.phase}</Text>
        <Text color={t.textDim}>{dur}</Text>
        {toolLabel && <Text color={t.textDim}> [{toolLabel}]</Text>}
        {e.summary && <Text color={t.textDim}> {e.summary}</Text>}
      </Text>
    );
  },
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
  escalate: (e, { t }) => (
    <Box flexDirection="column">
      <Box>
        <Text color={t.planner} bold>
          escalate{" "}
        </Text>
        <Text color={t.textDim}>tier {e.tier}</Text>
        {e.hint && <Text color={t.textDim}> — hint</Text>}
      </Box>
      {e.hint && (
        <Box marginLeft={2}>
          <Text color={t.textDim}>{e.hint}</Text>
        </Box>
      )}
    </Box>
  ),
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
  "cost-prediction": (e, { t }) => (
    <Box flexDirection="column">
      <Text color={t.accent} bold>
        Cost Estimate
      </Text>
      <Box marginLeft={3}>
        <Text color={t.success}>Low: {formatCost(e.prediction.lowCost)}</Text>
        <Text color={t.textDim}> (all local) </Text>
        <Text color={t.warning}>
          Expected: {formatCost(e.prediction.expectedCost)}
        </Text>
        <Text color={t.textDim}> </Text>
        <Text color={t.error}>High: {formatCost(e.prediction.highCost)}</Text>
      </Box>
      <Box marginLeft={3}>
        <Text color={t.textDim}>Planner: </Text>
        <Text color={t.planner}>
          {getProviderDisplayName(e.prediction.plannerTool)}
        </Text>
        <Text color={t.textDim}> Implementer: </Text>
        <Text color={t.implementer}>
          {getProviderDisplayName(e.prediction.implementerTool)}
        </Text>
        <Text color={t.textDim}> ({e.prediction.estimatedTasks} tasks)</Text>
      </Box>
    </Box>
  ),
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
  "workflow-config": (e, { t }) => (
    <Box flexDirection="column">
      <Text color={t.accent} bold>
        ⚙ Workflow Configuration
      </Text>
      <Box marginLeft={3}>
        <Text color={t.textDim}>Mode: </Text>
        <Text color={t.text}>{e.mode}</Text>
        <Text color={t.textDim}> Planner: </Text>
        <Text color={t.planner}>{getProviderDisplayName(e.plannerTool)}</Text>
        {e.plannerModel && <Text color={t.textDim}> ({e.plannerModel})</Text>}
        <Text color={t.textDim}> Implementer: </Text>
        <Text color={t.implementer}>
          {getProviderDisplayName(e.implementerTool)}
        </Text>
        {e.implementerModel && (
          <Text color={t.textDim}> ({e.implementerModel})</Text>
        )}
      </Box>
    </Box>
  ),
};

function getGutterRole(event: TuiEvent): "planner" | "implementer" | null {
  switch (event.type) {
    case "planner-status":
      return phaseRole(event.phase);
    case "planner-text":
    case "task-start":
      return "planner";
    case "implementer-generate-running":
    case "implementer-generate-done":
    case "implementer-generate-failed":
    case "validate":
    case "git-commit":
    case "git-checkpoint":
    case "retry":
      return "implementer";
    case "escalate":
      return "planner";
    case "warning":
    case "error":
    case "task-complete":
    case "task-skipped":
    case "cost-update":
    case "cost-prediction":
    case "budget-warning":
    case "budget-exceeded":
    case "workflow-cancelled":
    case "workflow-config":
      return null;
    default:
      return assertNever(event);
  }
}

export function EventCard({ event, diffExpanded }: EventCardProps) {
  const t = useTheme();
  const render = RENDERERS[event.type] as EventRenderer<typeof event.type>;
  const ctx: RenderCtx = { t, diffExpanded: diffExpanded ?? false };
  const content = render(
    event as Extract<TuiEvent, { type: typeof event.type }>,
    ctx,
  );
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
