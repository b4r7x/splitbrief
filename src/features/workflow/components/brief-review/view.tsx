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
import {
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../../../utils/display-text.js';
import type { BriefRecoveryProjectionV1 } from '../../../../core/schemas/brief-recovery/document.js';
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
import { TaskRow, type BriefReviewIssue } from './task-row.js';
import { useBriefData, type BriefDataLoader } from './use-load-state.js';

export interface BriefReviewViewProps {
  filePath: string;
  height?: number;
  width?: number;
  /** Optional injected projection for standalone review renders and deterministic fixtures. */
  recovery?: BriefRecoveryProjectionV1 | null | undefined;
  load?: BriefDataLoader | undefined;
}

const RECOVERY_HEADER_EXTRA_ROWS = 5;

function issueTaskId(issue: BriefReviewIssue): string | null {
  return typeof issue.taskId === 'string' ? issue.taskId : null;
}

function reviewIssues(
  recovery: BriefRecoveryProjectionV1 | null,
  quality: ReturnType<typeof useBriefData>['quality'],
): readonly BriefReviewIssue[] {
  if (recovery?.matchingReport !== null && recovery?.matchingReport !== undefined) {
    return recovery.matchingReport.issues;
  }
  return quality?.issues ?? [];
}

function generalIssue(issue: BriefReviewIssue): boolean {
  const taskId = issueTaskId(issue);
  return taskId === null || taskId === 'T000';
}

function issueLine(issue: BriefReviewIssue): string {
  const scope = issueTaskId(issue) ?? 'GENERAL';
  return `${scope}: ${sanitizeTerminalDisplayText(issue.message)}`;
}

function GeneralIssuePanel({
  issues,
  width,
}: {
  issues: readonly BriefReviewIssue[];
  width: number;
}) {
  const t = useTheme();
  if (issues.length === 0) return null;
  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      <Text color={t.error} bold wrap="truncate">
        general issues
      </Text>
      {issues.slice(0, 2).map((issue) => (
        <Text key={`${issueTaskId(issue) ?? 'general'}:${issue.code}`} wrap="wrap">
          {truncateTerminalDisplayText(issueLine(issue), Math.max(1, width))}
        </Text>
      ))}
    </Box>
  );
}

function EmptyBriefPanel({
  recovery,
  issues,
  width,
}: {
  recovery: BriefRecoveryProjectionV1 | null;
  issues: readonly BriefReviewIssue[];
  width: number;
}) {
  const firstIssue = issues[0];
  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      <Text bold wrap="truncate">
        No Task Briefs
      </Text>
      {recovery === null && (
        <>
          <Text wrap="truncate">
            {truncateTerminalDisplayText(
              firstIssue === undefined
                ? 'BECAUSE the planner returned no Task Briefs'
                : `BECAUSE ${issueLine(firstIssue)}`,
              Math.max(1, width),
            )}
          </Text>
          <Text wrap="truncate">SO implementation cannot start</Text>
          <Text wrap="truncate">NOW retry planning, edit, or reject</Text>
        </>
      )}
    </Box>
  );
}

export function BriefReviewView({
  filePath,
  height,
  width,
  recovery: recoveryProp,
  load,
}: BriefReviewViewProps) {
  const t = useTheme();
  const briefData = useBriefData(filePath, load);
  const { status, tasks, quality, readiness, reviewMetadata, briefSources } = briefData;
  const recovery =
    status === 'loading' ? null : recoveryProp === undefined ? briefData.recovery : recoveryProp;
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
  const isLoading = status === 'loading';

  const allIssues = reviewIssues(recovery, quality);
  const generalIssues = allIssues.filter(generalIssue);
  const issuePanelRows =
    tasks.length === 0
      ? generalIssues.length > 0
        ? Math.min(3, generalIssues.length + 1)
        : recovery === null
          ? 4
          : 1
      : generalIssues.length > 0
        ? Math.min(3, generalIssues.length + 1)
        : 0;
  const baseTaskRowBudget = getSimpleBriefTaskRowBudget({ containerHeight, hasLoadError });
  const taskRowBudget = Math.max(
    0,
    baseTaskRowBudget - (recovery === null ? 0 : RECOVERY_HEADER_EXTRA_ROWS) - issuePanelRows,
  );
  const taskBoxHeight = getSimpleBriefVisibleTaskCount({
    rowBudget: taskRowBudget,
    taskCount: tasks.length,
  });
  const {
    visibleItems: visibleTasks,
    previousCount,
    nextCount,
  } = getSimpleBriefVisibleSlice({
    items: tasks,
    rowBudget: taskRowBudget,
    scrollOffset: reviewScrollOffset,
  });
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
        readiness={readiness}
        filePath={filePath}
        width={innerWidth}
        hasLoadError={hasLoadError}
        recovery={recovery}
        maxRows={recovery === null ? undefined : Math.min(6, Math.max(1, containerHeight - 2))}
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
      ) : isLoading ? (
        <Box width={innerWidth} overflow="hidden">
          <Text color={t.textDim} wrap="truncate">
            loading briefs…
          </Text>
        </Box>
      ) : (
        <>
          {tasks.length === 0 ? (
            <EmptyBriefPanel recovery={recovery} issues={generalIssues} width={innerWidth} />
          ) : (
            <>
              <GeneralIssuePanel issues={generalIssues} width={innerWidth} />
              <Box flexDirection="column" height={taskBoxHeight} overflow="hidden">
                {visibleTasks.map((task, index) => {
                  const issuesForTask = allIssues.filter((issue) => issueTaskId(issue) === task.id);
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
            </>
          )}
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
