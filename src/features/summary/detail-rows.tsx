import { Box, Text } from 'ink';
import type { Theme } from '../../components/theme.js';
import type { EvidenceLedger } from '../../core/schemas/evidence.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { ScrollableDocumentRow } from '../../components/scrollable-document.js';
import { SOFT_SEP } from '../../components/separators.js';
import { formatCost } from '../../core/formatting.js';
import { getMethodDisplay } from '../../core/sessions/display.js';
import { stripTerminalControls, truncateTerminalDisplayText } from '../../utils/display-text.js';
import { buildCostBreakdownRows } from './components/cost-breakdown.js';
import { buildPhaseTimingRows } from './components/phase-timing.js';
import { buildCheckpointDetailRows } from './components/checkpoints.js';
import { buildReviewPacketDetailRows } from './components/review-packet.js';
import { glyph } from '../../lib/glyphs.js';

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

function spacerRow(key: string): ScrollableDocumentRow {
  return { key, node: <Text> </Text> };
}

function sectionHeaderRow(key: string, label: string, theme: Theme): ScrollableDocumentRow {
  return { key, node: <Text color={theme.textDim}>{label}</Text> };
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

  if (summary.taskBreakdown && summary.taskBreakdown.length > 0) {
    if (rows.length > 0) rows.push(spacerRow('tasks-spacer'));
    rows.push(sectionHeaderRow('tasks-heading', 'Tasks', theme));
    for (const task of summary.taskBreakdown) {
      const method = getMethodDisplay(task.method, theme);
      rows.push({
        key: `task:${task.taskId}`,
        node: (
          <>
            <Box width={2} flexShrink={0} />
            <Box width={6} flexShrink={0}>
              <Text color={theme.textDim} wrap="truncate-end">
                {task.taskId}
              </Text>
            </Box>
            <Box width={taskTitleWidth} flexShrink={0}>
              <Text wrap="truncate-end">
                {truncateTerminalDisplayText(task.taskTitle, truncateLength)}
              </Text>
            </Box>
            <Box width={10} flexShrink={0}>
              <Text color={theme.textDim} wrap="truncate-end">
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
    if (rows.length > 0) rows.push(spacerRow('evidence-spacer'));
    rows.push(...buildEvidenceDetailRows(summary, evidenceLedger, isSmall, theme));
  }

  if (summary.checkpointSummary) {
    if (rows.length > 0) rows.push(spacerRow('checkpoints-spacer'));
    rows.push(...buildCheckpointDetailRows(summary.checkpointSummary, isSmall, theme));
  }

  if (summary.reviewPacket) {
    if (rows.length > 0) rows.push(spacerRow('review-packet-spacer'));
    rows.push(...buildReviewPacketDetailRows(summary, sessionId, isSmall, theme));
  }

  if (summary.phaseTimings) {
    if (rows.length > 0) rows.push(spacerRow('phase-spacer'));
    rows.push(...buildPhaseTimingRows({ phaseTimings: summary.phaseTimings, labelWidth, theme }));
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

  const e = summary.evidenceSummary;
  const truncateLen = isSmall ? 24 : 48;
  const titleLen = isSmall ? 24 : 30;
  const rows: ScrollableDocumentRow[] = [
    {
      key: 'evidence-heading',
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          Evidence{SOFT_SEP}
          {stripTerminalControls(e.path)}
          {SOFT_SEP}
          {e.tasksWithValidationEvidence}/{e.totalTasks} validated{SOFT_SEP}
          {e.escalatedTasks} escalated{SOFT_SEP}
          {e.failedTasks} failed
        </Text>
      ),
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
        ? truncateTerminalDisplayText(task.expectedEvidence.join('; '), truncateLen)
        : '—';
    const observed =
      task.observedEvidence.length > 0
        ? truncateTerminalDisplayText(task.observedEvidence.join('; '), truncateLen)
        : '—';
    const done = task.status === 'done' && !task.escalated;
    const marker = done ? glyph('check') : glyph('statusPending');
    const markerColor = done ? theme.success : theme.textDim;
    const detailParts = [`passed ${passed}`];
    if (retries) detailParts.push(`retries ${retries}`);
    detailParts.push(`expected ${expected}`);
    detailParts.push(`observed ${observed}`);

    rows.push({
      key: `evidence-task:${task.id}`,
      node: (
        <Text>
          <Text color={markerColor}>
            {'  '}
            {marker} {task.id}{' '}
          </Text>
          <Text>{truncateTerminalDisplayText(task.title, titleLen)}</Text>
        </Text>
      ),
    });
    rows.push({
      key: `evidence-task:${task.id}:detail`,
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          {'  '}
          {glyph('treeLast')} {detailParts.join(SOFT_SEP)}
        </Text>
      ),
    });
  }

  if (ledger?.finalReview) {
    rows.push({
      key: 'evidence-final-review',
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          final review: {ledger.finalReview.status}
          {SOFT_SEP}
          {stripTerminalControls(ledger.finalReview.path)}
        </Text>
      ),
    });
  }

  return rows;
}
