import { Text } from 'ink';
import { LabeledRow } from '../../../components/labeled-row.js';
import type { CheckpointSummaryRollup } from '../../../core/schemas/summary.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document.js';
import type { Theme } from '../../../components/theme.js';
import { truncateWithEllipsis } from '../../../utils/truncate.js';
import { countNoun } from '../../../utils/pluralize.js';

function compactCheckpointCount(count: number): string {
  return count === 1 ? '1 ckpt' : `${count} ckpts`;
}

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
  if (isSmall) return summary.latestId ?? 'n/a';

  const id = summary.latestId ?? 'n/a';
  const prefix = uniqueParts([summary.latestKind, summary.latestName]).join(' ');
  const text = prefix ? `${prefix} ${id}` : id;
  return truncateWithEllipsis(text, maxLength);
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
  if (command) return command;
  if (!checkpointId) return null;
  return `diptych snapshot ${action} ${checkpointId}`;
}

function checkpointSummaryText(
  summary: CheckpointSummaryRollup,
  latest: string,
  isSmall: boolean,
): string {
  if (isSmall) return compactCheckpointCount(summary.count);

  const parts = [countNoun(summary.count, 'checkpoint'), `latest: ${latest}`].filter(
    (part): part is string => part !== null,
  );
  return parts.join(' | ');
}

export function buildCheckpointDetailRows(
  checkpointSummary: CheckpointSummaryRollup,
  labelWidth: number,
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
  const runStatusColor =
    runStatus === 'rejected'
      ? theme.warning
      : runStatus === 'accepted'
        ? theme.success
        : theme.textDim;

  const rows: ScrollableDocumentRow[] = [
    {
      key: 'checkpoints-summary',
      node: (
        <LabeledRow label="Checkpoints" labelWidth={labelWidth}>
          <Text color={theme.textDim} wrap="truncate-end">
            {summaryText}
          </Text>
        </LabeledRow>
      ),
    },
  ];

  if (isSmall) {
    rows.push({
      key: 'checkpoints-latest',
      node: (
        <LabeledRow label="" labelWidth={0}>
          <Text color={theme.textDim} wrap="truncate-end">
            latest: {checkpointSummary.latestId ?? 'n/a'}
          </Text>
        </LabeledRow>
      ),
    });
    if (checkpointSummary.preFinalReviewId) {
      rows.push({
        key: 'checkpoints-pre',
        node: (
          <LabeledRow label="" labelWidth={0}>
            <Text color={theme.textDim} wrap="truncate-end">
              pre: {checkpointSummary.preFinalReviewId}
            </Text>
          </LabeledRow>
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
          <LabeledRow label="" labelWidth={0}>
            <Text color={theme.textDim} wrap="truncate-end">
              latest run: {checkpointSummary.latestRunCheckpointId}
            </Text>
          </LabeledRow>
        ),
      });
    }
    if (runStatus) {
      rows.push({
        key: 'checkpoints-run-status',
        node: (
          <LabeledRow label="" labelWidth={0}>
            <Text color={runStatusColor} wrap="truncate-end">
              run status: {runStatus}
            </Text>
          </LabeledRow>
        ),
      });
    }
  } else {
    if (checkpointSummary.preFinalReviewId) {
      rows.push({
        key: 'checkpoints-pre',
        node: (
          <LabeledRow label="" labelWidth={0}>
            <Text color={theme.textDim} wrap="truncate-end">
              pre-final-review: {checkpointSummary.preFinalReviewId}
            </Text>
          </LabeledRow>
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
          <LabeledRow label="" labelWidth={0}>
            <Text color={theme.textDim} wrap="truncate-end">
              latest run: {checkpointSummary.latestRunCheckpointId}
            </Text>
          </LabeledRow>
        ),
      });
    }
    if (runStatus) {
      rows.push({
        key: 'checkpoints-run-status',
        node: (
          <LabeledRow label="" labelWidth={0}>
            <Text color={runStatusColor} wrap="truncate-end">
              run status: {runStatus}
            </Text>
          </LabeledRow>
        ),
      });
    }
  }

  if (diffCommand) {
    rows.push({
      key: 'checkpoints-diff',
      node: (
        <LabeledRow label="" labelWidth={0}>
          <Text color={theme.textDim} wrap="truncate-end">
            diff: {diffCommand}
          </Text>
        </LabeledRow>
      ),
    });
  }
  if (restoreCommand) {
    rows.push({
      key: 'checkpoints-restore',
      node: (
        <LabeledRow label="" labelWidth={0}>
          <Text color={theme.textDim} wrap="truncate-end">
            restore: {restoreCommand}
          </Text>
        </LabeledRow>
      ),
    });
  }
  rows.push({
    key: 'checkpoints-restore-note',
    node: (
      <Text color={runStatus === 'rejected' ? runStatusColor : theme.textDim} wrap="truncate-end">
        restore: hash-guarded; conflicts skipped{isSmall ? '' : ' by default'}; --force destructive
        overwrite
      </Text>
    ),
  });

  return rows;
}
