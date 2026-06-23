import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { BriefQualityIssue } from '../../../../engine/spec/brief-quality.js';
import type { PlanTaskReviewMetadata } from '../../../../core/plan-review/types.js';
import { MultilineInput } from '../../../../components/input/multiline-input.js';
import { planEditorStore } from '../../../../stores/workflow/plan-editor.js';
import {
  TASK_BRIEF_SECTIONS,
  getTaskBriefSectionLabel,
  getTaskBriefSectionText,
  type TaskBriefSection,
} from '../../../../stores/workflow/plan-editor-sections.js';
import {
  buildTaskDetailParts,
  formatContextFit,
  formatTaskReviewLine,
  getTaskStatusSymbol,
  hasTaskReviewWarning,
} from '../../brief-review-format.js';
import { formatTaskIdentityParts } from '../../layout/task-row.js';
import { getEditingInputRows } from './virtualization.js';
import {
  sanitizeTaskDisplayBlock,
  sanitizeTaskDisplayItems,
  sanitizeTaskDisplayText,
} from './task-format.js';

const MAX_SECTION_EDIT_ROWS = 6;

function DetailList({ label, items }: { label: string; items: string[] }) {
  const t = useTheme();
  const displayItems = sanitizeTaskDisplayItems(items);
  if (displayItems.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>{label}:</Text>
      {displayItems.map((item, i) => (
        <Box key={`${label}-${i}`} flexDirection="row" paddingLeft={2}>
          <Text color={t.textDim}>- </Text>
          <Text color={t.text} wrap="truncate">
            {item}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function TaskEditorDetail({
  task,
  metadata,
  isCursor,
  width,
}: {
  task: Task;
  metadata?: PlanTaskReviewMetadata | undefined;
  isCursor: boolean;
  width: number;
}) {
  const t = useTheme();
  const focus = planEditorStore.use((s) => s.focus);
  const sectionCursor = planEditorStore.use((s) => s.sectionCursor);
  const editing = planEditorStore.use((s) => s.editing);
  const reviewItems = [
    `worker ${metadata?.workerProfile ?? 'auto'}`,
    `cost ${metadata?.selectedCostTier ?? 'pending'}`,
    `fit ${formatContextFit(metadata)}`,
    `validation ${metadata?.validationStatus ?? 'pending'}`,
    `risk ${metadata?.risk ?? 'pending'}`,
  ];
  const scopeItems = [
    ...(task.scope?.inBounds ?? []).map((item) => `in ${item}`),
    ...(task.scope?.outOfBounds ?? []).map((item) => `out ${item}`),
    ...(task.scope?.approvedOutOfBounds ?? []).map((item) => `approved ${item}`),
  ];
  const routingItems = [
    metadata?.checkpoint ? `checkpoint ${metadata.checkpoint}` : null,
    metadata?.costPosture ? metadata.costPosture : null,
    metadata?.routingReason ? metadata.routingReason : null,
    metadata?.conflict ? `${metadata.conflict.kind}: ${metadata.conflict.files.join(', ')}` : null,
    metadata?.conflict?.note ? metadata.conflict.note : null,
    metadata?.stale ? 'stale input marker present' : null,
  ].filter((item): item is string => item !== null);
  const description = sanitizeTaskDisplayText(task.description);

  return (
    <Box flexDirection="column" paddingLeft={4}>
      <Box flexDirection="row">
        <Text color={t.textDim}>scope: </Text>
        <Text color={t.text} wrap="truncate">
          {description}
        </Text>
      </Box>
      <DetailList label="review" items={reviewItems} />
      <DetailList label="scope bounds" items={scopeItems} />
      <DetailList label="steps" items={task.implementationSteps} />
      <DetailList label="constraints" items={task.constraints} />
      <DetailList label="tests" items={task.tests} />
      <DetailList label="evidence" items={task.evidence ?? []} />
      <DetailList label="escalation" items={task.escalation ?? []} />
      <DetailList label="routing" items={routingItems} />
      {isCursor && focus !== 'task-list' && (
        <Box flexDirection="column">
          <Text color={t.textDim}>sections:</Text>
          {TASK_BRIEF_SECTIONS.map((section, index) => (
            <TaskBriefSectionRow
              key={section}
              task={task}
              section={section}
              selected={sectionCursor === index}
              editing={editing?.section === section ? editing : null}
              width={width}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

function TaskBriefSectionRow({
  task,
  section,
  selected,
  editing,
  width,
}: {
  task: Task;
  section: TaskBriefSection;
  selected: boolean;
  editing: { value: string } | null;
  width: number;
}) {
  const t = useTheme();
  const label = getTaskBriefSectionLabel(section);
  const value = getTaskBriefSectionText(task, section);
  const preview = firstPreviewLine(value);
  const marker = selected ? '› ' : '  ';
  const editColumns = Math.max(20, width - 10);
  const editRows = editing ? getEditingInputRows(editing.value) : 1;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Text color={selected ? t.accent : t.textDim}>{marker}</Text>
        <Text color={selected ? t.accent : t.textDim}>{label}: </Text>
        {editing === null && (
          <Text color={preview ? t.text : t.textDim} wrap="truncate">
            {preview || 'empty'}
          </Text>
        )}
      </Box>
      {editing !== null && (
        <Box paddingLeft={4}>
          <MultilineInput
            value={editing.value}
            onChange={planEditorStore.updateEditingValue}
            onSubmit={() => planEditorStore.saveEditingSection()}
            columns={editColumns}
            rows={editRows}
            maxRows={MAX_SECTION_EDIT_ROWS}
            focus
            keyBindings={{
              submit: (key) => key.ctrl && key.return,
              newline: (key) => key.return && !key.ctrl,
            }}
          />
        </Box>
      )}
    </Box>
  );
}

function firstPreviewLine(value: string): string {
  return (
    sanitizeTaskDisplayBlock(value)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

export function TaskEditorRow({
  task,
  metadata,
  isCursor,
  isExpanded,
  isFlagged,
  issues,
  width,
}: {
  task: Task;
  metadata?: PlanTaskReviewMetadata | undefined;
  isCursor: boolean;
  isExpanded: boolean;
  isFlagged: boolean;
  issues: BriefQualityIssue[];
  width: number;
}) {
  const t = useTheme();
  const hasConflict = metadata?.conflict !== undefined;
  const hasOverflow = metadata?.contextFit === 'overflow';
  const hasWarning = hasTaskReviewWarning(issues, metadata);
  const statusSymbol = getTaskStatusSymbol(issues, metadata);
  const statusColor =
    hasConflict || hasOverflow || metadata?.validationStatus === 'fail'
      ? t.error
      : hasWarning
        ? t.warning
        : t.success;
  const detailLine = sanitizeTaskDisplayText(buildTaskDetailParts(task));
  const reviewLine = sanitizeTaskDisplayText(formatTaskReviewLine(task, issues, metadata));
  const taskFile = sanitizeTaskDisplayText(task.file);
  const taskTitle = sanitizeTaskDisplayText(task.title);
  const prefix = isCursor ? '> ' : '  ';
  const flag = isFlagged ? '✗ ' : '';
  const identity = formatTaskIdentityParts({
    width,
    prefix,
    flag,
    statusSymbol,
    taskId: task.id,
    status: task.status,
    file: taskFile,
    title: taskTitle,
  });

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" width={width} overflow="hidden">
        <Text color={isCursor ? t.accent : t.text}>{identity.prefix}</Text>
        {identity.flag !== '' && <Text color={t.error}>{identity.flag}</Text>}
        <Text color={statusColor}>{identity.statusSymbol}</Text>
        <Text bold color={t.accent}>
          {identity.taskId}
        </Text>
        <Text> </Text>
        <Text color={t.textDim}>{identity.status}</Text>
        {identity.file !== '' && (
          <>
            <Text> </Text>
            <Text color={t.textDim}>{identity.file}</Text>
          </>
        )}
        <Text> </Text>
        <Text bold={isCursor} color={t.text}>
          {identity.title}
        </Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color={t.textDim} wrap="truncate">
          {detailLine}
        </Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color={hasWarning ? t.warning : t.textDim} wrap="truncate">
          {reviewLine}
        </Text>
      </Box>
      {isExpanded && (
        <TaskEditorDetail task={task} metadata={metadata} isCursor={isCursor} width={width} />
      )}
    </Box>
  );
}
