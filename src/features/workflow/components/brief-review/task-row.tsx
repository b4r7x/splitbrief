import { Box, Text } from 'ink';
import { CursorCell } from '../../../../components/pickers/cursor-cell.js';
import { useTheme } from '../../../../components/theme.js';
import type { Theme } from '../../../../components/theme.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import {
  STALE_ESTIMATE_STATUSES,
  hasNoCapableWorker,
} from '../../../../core/plan-review/predicates.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../../core/plan-review/types.js';
import type * as BriefRecoverySchemas from '../../../../core/schemas/brief-recovery.js';
import type * as LegacyBriefQuality from '../../../../engine/spec/brief-quality.js';
import { sanitizeTaskDisplayText } from '../../brief-review-format.js';
import { formatTaskIdentityParts } from '../../layout/task-row.js';

export type BriefReviewIssue =
  | BriefRecoverySchemas.BriefQualityIssue
  | LegacyBriefQuality.BriefQualityIssue;

interface TaskStateWord {
  text: string;
  color: string;
  dim: boolean;
}

function getTaskStateWord(
  issues: readonly BriefReviewIssue[],
  metadata: PlanTaskReviewMetadata | undefined,
  theme: Theme,
): TaskStateWord | null {
  if (metadata?.contextFit === 'overflow')
    return { text: 'overflow', color: theme.error, dim: true };
  if (metadata?.conflict !== undefined) return { text: 'conflict', color: theme.error, dim: true };
  if (metadata !== undefined && hasNoCapableWorker(metadata))
    return { text: 'no worker', color: theme.warning, dim: true };
  if (metadata?.validationStatus === 'fail' || issues.some((i) => i.severity === 'error'))
    return { text: 'failed', color: theme.error, dim: true };
  if (
    metadata?.stale ||
    STALE_ESTIMATE_STATUSES.has(metadata?.estimateStatus) ||
    metadata?.validationStatus === 'warn' ||
    issues.some((i) => i.severity === 'warning')
  )
    return { text: 'stale', color: theme.warning, dim: false };
  return null;
}

export function TaskRow({
  task,
  issues,
  metadata,
  width,
  focused,
  hovered,
}: {
  task: Task;
  issues: readonly BriefReviewIssue[];
  metadata: PlanTaskReviewMetadata | undefined;
  width: number;
  focused: boolean;
  hovered: boolean;
}) {
  const t = useTheme();
  const word = getTaskStateWord(issues, metadata, t);
  const wordCells = word ? getTerminalCellWidth(word.text) + 1 : 0;
  const budgetWidth = Math.max(1, width - 2 - wordCells);
  const identity = formatTaskIdentityParts({
    width: budgetWidth,
    statusSymbol: '',
    taskId: task.id,
    status: '',
    file: sanitizeTaskDisplayText(task.file),
    title: sanitizeTaskDisplayText(task.title),
  });

  return (
    <Box
      flexDirection="row"
      width={width}
      overflow="hidden"
      backgroundColor={hovered ? t.selectionBg : undefined}
    >
      <CursorCell isCursor={focused} dimWhenInactive />
      <Text bold={focused} color={focused ? t.accent : t.textDim}>
        {identity.taskId}
      </Text>
      <Text>{'  '}</Text>
      {identity.file !== '' && (
        <>
          <Text color={t.textDim}>{identity.file}</Text>
          <Text>{'  '}</Text>
        </>
      )}
      <Box flexGrow={1} overflow="hidden">
        <Text color={focused ? t.accent : t.text} wrap="truncate">
          {identity.title}
        </Text>
      </Box>
      {word && (
        <Text color={word.color} dimColor={word.dim} wrap="truncate">
          {' '}
          {word.text}
        </Text>
      )}
      {issues.length > 0 && (
        <Text color={t.textDim} wrap="truncate">
          {' · '}
          {sanitizeTaskDisplayText(issues[0]?.message ?? '')}
        </Text>
      )}
    </Box>
  );
}
