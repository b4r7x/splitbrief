import { Text } from 'ink';
import type { CheckpointSummaryRollup } from '../../../core/schemas/summary.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document.js';
import type { Theme } from '../../../components/theme.js';
import { stripTerminalControls, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';

function uniqueParts(parts: (string | null)[]): string[] {
  const seen = new Set<string>();
  return parts.filter((part): part is string => {
    if (!part || seen.has(part)) return false;
    seen.add(part);
    return true;
  });
}

function formatLatestCheckpoint(
  summary: CheckpointSummaryRollup,
  maxLength: number,
  isSmall: boolean,
): string {
  if (isSmall) return stripTerminalControls(summary.latestId ?? 'n/a');

  const id = summary.latestId ?? 'n/a';
  const prefix = uniqueParts([summary.latestKind, summary.latestName]).join(' ');
  const text = prefix ? `${prefix} ${id}` : id;
  return truncateTerminalDisplayText(text, maxLength);
}

function formatRunStatus(summary: CheckpointSummaryRollup): string | null {
  if (summary.accepted === true) return 'accepted';
  if (summary.rejected === true) return 'rejected';
  if (summary.accepted !== null || summary.rejected !== null) return 'pending';
  return null;
}

function commandFor(
  command: string | null,
  action: 'diff' | 'restore',
  checkpointId: string | null,
): string | null {
  if (command) return stripTerminalControls(command);
  if (!checkpointId) return null;
  return `${SPLITBRIEF_IDENTITY.executable} snapshot ${action} ${stripTerminalControls(checkpointId)}`;
}

function checkpointSummaryText(
  summary: CheckpointSummaryRollup,
  latest: string,
  isSmall: boolean,
): string {
  if (isSmall) return countNoun(summary.count, 'ckpt');

  return `${countNoun(summary.count, 'checkpoint')} · latest: ${latest}`;
}

export function buildCheckpointDetailRows(
  checkpointSummary: CheckpointSummaryRollup,
  isSmall: boolean,
  theme: Theme,
): ScrollableDocumentRow[] {
  const latest = formatLatestCheckpoint(checkpointSummary, 88, isSmall);
  const runStatus = formatRunStatus(checkpointSummary);
  const diffCommand = commandFor(checkpointSummary.diffCommand, 'diff', checkpointSummary.latestId);
  const restoreCommand = commandFor(
    checkpointSummary.restoreCommand,
    'restore',
    checkpointSummary.latestId,
  );
  const summaryText = checkpointSummaryText(checkpointSummary, latest, isSmall);
  const safeLatestId = stripTerminalControls(checkpointSummary.latestId ?? 'n/a');
  const safePreFinalReviewId = checkpointSummary.preFinalReviewId
    ? stripTerminalControls(checkpointSummary.preFinalReviewId)
    : '';
  const safeLatestRunCheckpointId = checkpointSummary.latestRunCheckpointId
    ? stripTerminalControls(checkpointSummary.latestRunCheckpointId)
    : '';
  const runStatusColor =
    runStatus === 'rejected'
      ? theme.warning
      : runStatus === 'accepted'
        ? theme.success
        : theme.textDim;

  const rows: ScrollableDocumentRow[] = [
    {
      key: 'checkpoints-heading',
      node: <Text color={theme.textDim}>Checkpoints</Text>,
    },
    {
      key: 'checkpoints-summary',
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          {'  '}
          {summaryText}
        </Text>
      ),
    },
  ];

  if (isSmall) {
    rows.push({
      key: 'checkpoints-latest',
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          {'  '}latest: {safeLatestId}
        </Text>
      ),
    });
    if (checkpointSummary.preFinalReviewId) {
      rows.push({
        key: 'checkpoints-pre',
        node: (
          <Text color={theme.textDim} wrap="truncate-end">
            {'  '}pre: {safePreFinalReviewId}
          </Text>
        ),
      });
    }
    if (
      checkpointSummary.latestRunCheckpointId &&
      checkpointSummary.latestRunCheckpointId !== checkpointSummary.latestId
    ) {
      rows.push({
        key: 'checkpoints-latest-run',
        node: (
          <Text color={theme.textDim} wrap="truncate-end">
            {'  '}latest run: {safeLatestRunCheckpointId}
          </Text>
        ),
      });
    }
    if (runStatus) {
      rows.push({
        key: 'checkpoints-run-status',
        node: (
          <Text color={runStatusColor} wrap="truncate-end">
            {'  '}run status: {runStatus}
          </Text>
        ),
      });
    }
  } else {
    if (checkpointSummary.preFinalReviewId) {
      rows.push({
        key: 'checkpoints-pre',
        node: (
          <Text color={theme.textDim} wrap="truncate-end">
            {'  '}pre-final-review: {safePreFinalReviewId}
          </Text>
        ),
      });
    }
    if (
      checkpointSummary.latestRunCheckpointId &&
      checkpointSummary.latestRunCheckpointId !== checkpointSummary.latestId
    ) {
      rows.push({
        key: 'checkpoints-latest-run',
        node: (
          <Text color={theme.textDim} wrap="truncate-end">
            {'  '}latest run: {safeLatestRunCheckpointId}
          </Text>
        ),
      });
    }
    if (runStatus) {
      rows.push({
        key: 'checkpoints-run-status',
        node: (
          <Text color={runStatusColor} wrap="truncate-end">
            {'  '}run status: {runStatus}
          </Text>
        ),
      });
    }
  }

  if (diffCommand) {
    rows.push({
      key: 'checkpoints-diff',
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          {'  '}diff: {diffCommand}
        </Text>
      ),
    });
  }
  if (restoreCommand) {
    rows.push({
      key: 'checkpoints-restore',
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          {'  '}restore: {restoreCommand}
        </Text>
      ),
    });
  }
  rows.push({
    key: 'checkpoints-restore-note',
    node: (
      <Text color={runStatus === 'rejected' ? runStatusColor : theme.textDim} wrap="truncate-end">
        {'  '}restore: hash-guarded · conflicts skipped{isSmall ? '' : ' by default'} · --force
        destructive
      </Text>
    ),
  });

  return rows;
}
