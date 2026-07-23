import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../../../components/separators.js';
import { borderStyleFor, glyph } from '../../../../lib/glyphs.js';
import {
  getScrollbarThumb,
  getScrollViewportContentWidth,
  scrollbarCell,
} from '../../../../components/scrollbar.js';
import { useTheme } from '../../../../components/theme.js';
import { truncateTerminalDisplayText } from '../../../../utils/display-text.js';
import type { Task } from '../../../../core/schemas/task.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import { focusStore } from '../../../../stores/ui/focus.js';
import { hoverStore } from '../../../../stores/ui/hover.js';
import { BriefFieldEditor } from '../../../editor/brief-field-editor.js';
import { useFieldSessionOwned } from '../../../editor/use-field-session-owned.js';
import { getInlineFieldEditContext } from '../../hooks/workflow-screen/use-inline-edit.js';
import {
  getSimpleBriefTaskRowBudget,
  getSimpleBriefVisibleSlice,
  getSimpleBriefVisibleTaskCount,
} from '../../layout/brief-review.js';
import { PlanReviewHeader } from './header.js';
import { TaskRow } from './task-row.js';
import { useBriefData } from './use-load-state.js';

export interface BriefReviewViewProps {
  filePath: string;
  height?: number;
  width?: number;
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
