import { Box, Text } from 'ink';
import type { Theme } from '../../components/theme.js';
import type { EvidenceLedger } from '../../core/schemas/evidence.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { ScrollableDocumentRow } from '../../components/scrollable-document.js';
import { statusGlyph } from '../../components/task-status-glyph.js';
import { formatCost } from '../../core/formatting.js';
import { getMethodDisplay } from '../../core/sessions/display.js';
import { truncateWithEllipsis } from '../../utils/truncate.js';
import { buildCostBreakdownRows } from './components/cost-breakdown.js';
import { buildPhaseTimingRows } from './components/phase-timing.js';
import { buildCheckpointDetailRows } from './components/checkpoints.js';
import { buildReviewPacketDetailRows } from './components/review-packet.js';

interface BuildSummaryDetailRowsInput {
  summary: Summary;
  evidenceLedger: EvidenceLedger | null;
  sessionId: string | undefined;
  labelWidth: number;
  taskTitleWidth: number;
  truncateLength: number;
  theme: Theme;
  isSmall: boolean;
  isShortSmall: boolean;
}

export function buildSummaryDetailRows(
  input: BuildSummaryDetailRowsInput,
): ScrollableDocumentRow[] {
  const {
    summary,
    evidenceLedger,
    sessionId,
    labelWidth,
    taskTitleWidth,
    truncateLength,
    theme,
    isSmall,
    isShortSmall,
  } = input;

  if (isShortSmall) return [];

  const rows: ScrollableDocumentRow[] = [];

  if (summary.costBreakdown) {
    rows.push(
      ...buildCostBreakdownRows({ costBreakdown: summary.costBreakdown, labelWidth, theme }),
    );
  }

  if (summary.taskBreakdown) {
    for (const task of summary.taskBreakdown) {
      const method = getMethodDisplay(task.method, theme);
      rows.push({
        key: `task:${task.taskId}`,
        node: (
          <>
            <Box width={6} flexShrink={0}>
              <Text color={theme.textDim} wrap="truncate-end">
                {task.taskId}
              </Text>
            </Box>
            <Box width={taskTitleWidth} flexShrink={0}>
              <Text wrap="truncate-end">
                {truncateWithEllipsis(task.taskTitle, truncateLength)}
              </Text>
            </Box>
            <Box width={10} flexShrink={0}>
              <Text color={method.color} wrap="truncate-end">
                {method.text}
              </Text>
            </Box>
            {task.retryCount > 0 && <Text color={theme.warning}>{task.retryCount}r</Text>}
            {task.cost != null && task.cost > 0 && (
              <Text color={theme.textDim}> {formatCost(task.cost)}</Text>
            )}
          </>
        ),
      });
    }
  }

  if (summary.evidenceSummary) {
    rows.push(...buildEvidenceDetailRows(summary, evidenceLedger, isSmall, theme));
  }

  if (summary.checkpointSummary) {
    rows.push(...buildCheckpointDetailRows(summary.checkpointSummary, labelWidth, isSmall, theme));
  }

  if (summary.reviewPacket) {
    rows.push(...buildReviewPacketDetailRows(summary, sessionId, isSmall, theme));
  }

  if (summary.phaseTimings) {
    rows.push(...buildPhaseTimingRows(summary.phaseTimings, labelWidth, theme));
  }

  return rows;
}

function buildEvidenceDetailRows(
  summary: Summary,
  ledger: EvidenceLedger | null,
  isSmall: boolean,
  theme: Theme,
): ScrollableDocumentRow[] {
  if (!summary.evidenceSummary) return [];

  const truncateLen = isSmall ? 28 : 60;
  const titleWidth = isSmall ? 18 : 26;
  const rows: ScrollableDocumentRow[] = [
    {
      key: 'evidence-heading',
      node: (
        <Text bold color={theme.text}>
          Evidence
        </Text>
      ),
    },
    {
      key: 'evidence-summary',
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          ledger: {summary.evidenceSummary.path} ·{' '}
          {summary.evidenceSummary.tasksWithValidationEvidence}/{summary.evidenceSummary.totalTasks}{' '}
          validated · {summary.evidenceSummary.escalatedTasks} escalated ·{' '}
          {summary.evidenceSummary.failedTasks} failed
        </Text>
      ),
      lines: isSmall ? 1 : 1,
    },
  ];

  for (const task of ledger?.tasks ?? []) {
    const passed =
      task.validation
        .filter((v) => v.passed)
        .map((v) => v.stage)
        .join(',') || '—';
    const retries = task.validation
      .filter((v) => v.retryState === 'retry' || v.retryState === 'escalated')
      .map((v) => `${v.stage}:${v.retryState}`)
      .join(',');
    const expected =
      task.expectedEvidence.length > 0
        ? truncateWithEllipsis(task.expectedEvidence.join('; '), truncateLen)
        : '—';
    const observed =
      task.observedEvidence.length > 0
        ? truncateWithEllipsis(task.observedEvidence.join('; '), truncateLen)
        : '—';

    rows.push({
      key: `evidence-task:${task.id}`,
      node: (
        <Text>
          <Text color={theme.textDim}>
            {statusGlyph(task.escalated ? 'escalated' : task.status)} {task.id}{' '}
          </Text>
          <Text>{truncateWithEllipsis(task.title, isSmall ? 24 : titleWidth - 6)}</Text>
        </Text>
      ),
    });
    rows.push({
      key: `evidence-task:${task.id}:passed`,
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          passed: {passed}
        </Text>
      ),
    });
    if (retries) {
      rows.push({
        key: `evidence-task:${task.id}:retries`,
        node: (
          <Text color={theme.textDim} wrap="truncate-end">
            retries: {retries}
          </Text>
        ),
      });
    }
    rows.push({
      key: `evidence-task:${task.id}:expected`,
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          expected: {expected}
        </Text>
      ),
    });
    rows.push({
      key: `evidence-task:${task.id}:observed`,
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          observed: {observed}
        </Text>
      ),
    });
  }

  if (ledger?.finalReview) {
    rows.push({
      key: 'evidence-final-review',
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          final review: {ledger.finalReview.status} ({ledger.finalReview.path})
        </Text>
      ),
    });
  }

  return rows;
}
