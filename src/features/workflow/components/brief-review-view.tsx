import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { dirname } from 'node:path';
import { SOFT_SEP } from '../../../components/separators.js';
import { borderStyleFor, glyph } from '../../../lib/glyphs.js';
import {
  getScrollbarThumb,
  getScrollViewportContentWidth,
  scrollbarCell,
} from '../../../components/scrollbar.js';
import { CursorCell } from '../../../components/pickers/cursor-cell.js';
import { useTheme } from '../../../components/theme.js';
import type { Theme } from '../../../components/theme.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { STALE_ESTIMATE_STATUSES } from '../../../core/plan-review/predicates.js';
import type { Task } from '../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../core/plan-review/types.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import { sanitizeTaskDisplayText } from '../brief-review-format.js';
import { loadBriefReviewData } from '../brief-review-loader.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { hoverStore } from '../../../stores/ui/hover.js';
import { BriefFieldEditor } from '../../editor/brief-field-editor.js';
import { useFieldSessionOwned } from '../../editor/use-field-session-owned.js';
import { getInlineFieldEditContext } from '../hooks/use-workflow-screen.js';
import {
  getSimpleBriefTaskRowBudget,
  getSimpleBriefVisibleSlice,
  getSimpleBriefVisibleTaskCount,
} from '../layout/brief-review.js';
import { formatTaskIdentityParts } from '../layout/task-row.js';
import { PlanReviewHeader } from './brief-review-header.js';

interface BriefReviewViewProps {
  filePath: string;
  height?: number;
  width?: number;
}

interface BriefData {
  tasks: Task[];
  quality: BriefQualityReport | null;
  reviewMetadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
  briefSources: string[];
}

function useBriefData(filePath: string): BriefData {
  const [data, setData] = useState<BriefData>({
    tasks: [],
    quality: null,
    reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
    briefSources: [],
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function load() {
      const { tasks, quality, reviewMetadata, briefSources } = await loadBriefReviewData({
        filePath,
        sessionDirPath: dirname(filePath),
        signal,
      });
      if (signal.aborted) return;
      setData({ tasks, quality, reviewMetadata, briefSources });
      reviewStore.setLoadError(null);
    }

    load().catch((err) => {
      if (!signal.aborted) {
        setData({
          tasks: [],
          quality: null,
          reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
          briefSources: [],
        });
        reviewStore.setLoadError(toErrorMessage(err));
      }
    });
    return () => {
      controller.abort();
    };
  }, [filePath]);

  return data;
}

interface TaskStateWord {
  text: string;
  color: string;
  dim: boolean;
}

function getTaskStateWord(
  issues: BriefQualityIssue[],
  metadata: PlanTaskReviewMetadata | undefined,
  theme: Theme,
): TaskStateWord | null {
  if (metadata?.contextFit === 'overflow')
    return { text: 'overflow', color: theme.error, dim: true };
  if (metadata?.conflict !== undefined) return { text: 'conflict', color: theme.error, dim: true };
  if (metadata?.validationStatus === 'fail' || issues.some((i) => i.severity === 'error'))
    return { text: 'failed', color: theme.error, dim: true };
  if (
    metadata?.stale === true ||
    STALE_ESTIMATE_STATUSES.has(metadata?.estimateStatus) ||
    metadata?.validationStatus === 'warn' ||
    issues.some((i) => i.severity === 'warning')
  )
    return { text: 'stale', color: theme.warning, dim: false };
  return null;
}

function TaskRow({
  task,
  issues,
  metadata,
  width,
  focused,
  hovered,
}: {
  task: Task;
  issues: BriefQualityIssue[];
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
    </Box>
  );
}

function getVisibleBriefTaskWindow(
  tasks: Task[],
  rowBudget: number,
  scrollOffset: number,
): {
  visibleTasks: Task[];
  previousCount: number;
  nextCount: number;
} {
  const { visibleItems, previousCount, nextCount } = getSimpleBriefVisibleSlice({
    items: tasks,
    rowBudget,
    scrollOffset,
  });
  return { visibleTasks: visibleItems, previousCount, nextCount };
}

export function BriefReviewView({ filePath, height, width }: BriefReviewViewProps) {
  const t = useTheme();
  const { tasks, quality, reviewMetadata, briefSources } = useBriefData(filePath);
  const reviewScrollOffset = reviewStore.use((s) => s.scrollOffset);
  const loadError = reviewStore.use((s) => s.loadError);
  const focusedBriefIndex = focusStore.use((f) =>
    f !== null && f.region === 'brief' ? f.index : null,
  );
  const hoveredBriefIndex = hoverStore.use((h) =>
    h !== null && h.surface === 'brief' ? h.index : null,
  );
  const fieldSessionOwned = useFieldSessionOwned();
  const inlineFieldEdit = fieldSessionOwned ? getInlineFieldEditContext() : null;
  const containerHeight = height ?? 24;
  const rowWidth = Math.max(1, width ?? 80);
  const innerWidth = Math.max(1, rowWidth - 4);
  const hasLoadError = loadError !== null;

  const taskRowBudget = getSimpleBriefTaskRowBudget({ containerHeight, hasLoadError });
  const taskBoxHeight = getSimpleBriefVisibleTaskCount({
    rowBudget: taskRowBudget,
    taskCount: tasks.length,
  });
  const { visibleTasks, previousCount, nextCount } = getVisibleBriefTaskWindow(
    tasks,
    taskRowBudget,
    reviewScrollOffset,
  );
  useEffect(() => {
    reviewStore.setRenderedLineCount(tasks.length);
  }, [tasks.length]);
  useEffect(() => {
    reviewStore.setBriefSources(briefSources);
  }, [briefSources]);
  useEffect(() => {
    reviewStore.setBriefPaths(tasks.map((task) => task.file));
  }, [tasks]);
  useEffect(() => {
    reviewStore.setVisibleBriefCount(taskBoxHeight);
  }, [taskBoxHeight]);

  const overflowNotice =
    previousCount > 0 || nextCount > 0
      ? [
          previousCount > 0 ? `↑ ${previousCount} more` : null,
          nextCount > 0 ? `↓ ${nextCount} more` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(SOFT_SEP)
      : null;
  const pagingHint = 'pgup/pgdn scroll';
  const overflowLine =
    overflowNotice !== null
      ? truncateTerminalDisplayText(`${overflowNotice}${SOFT_SEP}${pagingHint}`, innerWidth)
      : null;

  const hasScroll = taskBoxHeight > 0 && tasks.length > taskBoxHeight;
  const scrollThumb = getScrollbarThumb({
    offset: previousCount,
    lineCount: tasks.length,
    visibleHeight: taskBoxHeight,
  });
  const rowContentWidth = hasScroll
    ? Math.max(1, getScrollViewportContentWidth(rowWidth - 2))
    : innerWidth;

  return (
    <Box
      flexDirection="column"
      height={height}
      width={width}
      borderStyle={borderStyleFor('single')}
      borderColor={t.planner}
      borderDimColor
      paddingX={1}
      overflow="hidden"
    >
      <PlanReviewHeader
        tasks={tasks}
        quality={quality}
        filePath={filePath}
        width={innerWidth}
        hasLoadError={hasLoadError}
      />
      <Box height={1} />
      {inlineFieldEdit !== null ? (
        <BriefFieldEditor
          tasks={tasks}
          taskIndex={focusedBriefIndex ?? 0}
          sessionRef={inlineFieldEdit.sessionRef}
          resolve={inlineFieldEdit.resolve}
          height={taskRowBudget}
        />
      ) : loadError !== null ? (
        <Box width={innerWidth} overflow="hidden">
          <Text wrap="truncate">
            <Text color={t.error}>couldn't load briefs</Text>
            <Text color={t.textDim}>
              {`${SOFT_SEP}${loadError}${innerWidth >= 60 ? `${SOFT_SEP}run plan again or press e to open the file` : ''}`}
            </Text>
          </Text>
        </Box>
      ) : (
        <>
          <Box flexDirection="column" height={taskBoxHeight} overflow="hidden">
            {visibleTasks.map((task, index) => {
              const issuesForTask = quality?.issues.filter((i) => i.taskId === task.id) ?? [];
              const absoluteIndex = previousCount + index;
              const onThumb = scrollbarCell(index, scrollThumb);
              return (
                <Box key={task.id}>
                  <TaskRow
                    task={task}
                    issues={issuesForTask}
                    metadata={reviewMetadata.get(task.id)}
                    width={rowContentWidth}
                    focused={absoluteIndex === focusedBriefIndex}
                    hovered={absoluteIndex === hoveredBriefIndex}
                  />
                  {hasScroll && (
                    <>
                      <Text> </Text>
                      <Text color={onThumb ? t.accent : t.scrollIndicator}>
                        {onThumb ? glyph('scrollThumb') : glyph('scrollTrack')}
                      </Text>
                    </>
                  )}
                </Box>
              );
            })}
          </Box>
          {overflowLine !== null && (
            <>
              <Box height={1} />
              <Text color={t.textDim}>{overflowLine}</Text>
            </>
          )}
        </>
      )}
    </Box>
  );
}
