import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { BriefQualityIssue } from '../../../../engine/spec/brief-quality.js';
import type { PlanTaskReviewMetadata } from '../../../../stores/workflow/plan-editor.js';
import {
  buildTaskDetailParts,
  formatContextFit,
  formatTaskReviewLine,
  getTaskStatusSymbol,
  hasTaskReviewWarning,
} from '../brief-review-view.js';

function DetailList({ label, items }: { label: string; items: string[] }) {
  const t = useTheme();
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>{label}:</Text>
      {items.map((item, i) => (
        <Box key={`${label}-${i}`} flexDirection="row" paddingLeft={2}>
          <Text color={t.textDim}>- </Text>
          <Text color={t.text} wrap="truncate">{item}</Text>
        </Box>
      ))}
    </Box>
  );
}

function TaskEditorDetail({
  task,
  metadata,
}: {
  task: Task;
  metadata?: PlanTaskReviewMetadata | undefined;
}) {
  const t = useTheme();
  const reviewItems = [
    `worker ${metadata?.workerProfile ?? 'auto'}`,
    `cost ${metadata?.selectedCostTier ?? 'pending'}`,
    `fit ${formatContextFit(metadata)}`,
    `validation ${metadata?.validationStatus ?? 'pending'}`,
    `risk ${metadata?.risk ?? 'pending'}`,
  ];
  const scopeItems = [
    ...(task.scope?.inBounds ?? []).map(item => `in ${item}`),
    ...(task.scope?.outOfBounds ?? []).map(item => `out ${item}`),
    ...(task.scope?.approvedOutOfBounds ?? []).map(item => `approved ${item}`),
  ];
  const routingItems = [
    metadata?.checkpoint ? `checkpoint ${metadata.checkpoint}` : null,
    metadata?.costPosture ? metadata.costPosture : null,
    metadata?.routingReason ? metadata.routingReason : null,
    metadata?.conflict ? `${metadata.conflict.kind}: ${metadata.conflict.files.join(', ')}` : null,
    metadata?.conflict?.note ? metadata.conflict.note : null,
    metadata?.stale ? 'stale input marker present' : null,
  ].filter((item): item is string => item !== null);

  return (
    <Box flexDirection="column" paddingLeft={4}>
      <Box flexDirection="row">
        <Text color={t.textDim}>scope: </Text>
        <Text color={t.text} wrap="truncate">{task.description}</Text>
      </Box>
      <DetailList label="review" items={reviewItems} />
      <DetailList label="scope bounds" items={scopeItems} />
      <DetailList label="steps" items={task.implementationSteps} />
      <DetailList label="constraints" items={task.constraints} />
      <DetailList label="tests" items={task.tests} />
      <DetailList label="escalation" items={task.escalation ?? []} />
      <DetailList label="routing" items={routingItems} />
    </Box>
  );
}

export function TaskEditorRow({
  task,
  metadata,
  isCursor,
  isExpanded,
  isFlagged,
  issues,
}: {
  task: Task;
  metadata?: PlanTaskReviewMetadata | undefined;
  isCursor: boolean;
  isExpanded: boolean;
  isFlagged: boolean;
  issues: BriefQualityIssue[];
}) {
  const t = useTheme();
  const hasConflict = metadata?.conflict !== undefined;
  const hasOverflow = metadata?.contextFit === 'overflow';
  const hasWarning = hasTaskReviewWarning(issues, metadata);
  const statusSymbol = getTaskStatusSymbol(issues, metadata);
  const statusColor = hasConflict || hasOverflow || metadata?.validationStatus === 'fail'
    ? t.error
    : hasWarning
      ? t.warning
      : t.success;
  const detailLine = buildTaskDetailParts(task);
  const reviewLine = formatTaskReviewLine(task, issues, metadata);
  const prefix = isCursor ? '> ' : '  ';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={isCursor ? t.accent : t.text}>{prefix}</Text>
        {isFlagged && <Text color={t.error}>✗ </Text>}
        <Text color={statusColor}>{statusSymbol} </Text>
        <Text bold color={t.accent}>{task.id}</Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.status}</Text>
        <Text> </Text>
        <Text color={t.textDim}>{task.file}</Text>
        <Text>  </Text>
        <Text bold={isCursor} color={t.text}>{task.title}</Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color={t.textDim} wrap="truncate">{detailLine}</Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color={hasWarning ? t.warning : t.textDim} wrap="truncate">{reviewLine}</Text>
      </Box>
      {isExpanded && <TaskEditorDetail task={task} metadata={metadata} />}
    </Box>
  );
}
