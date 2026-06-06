import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import type { CheckpointSummaryRollup } from '../../../core/schemas/summary.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { truncateWithEllipsis } from '../../../utils/truncate.js';
import { pluralize } from '../../../utils/pluralize.js';

interface SummaryCheckpointsProps {
  checkpointSummary: CheckpointSummaryRollup | undefined;
}

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
  runStatus: string | null,
  isSmall: boolean,
): string {
  if (isSmall) return compactCheckpointCount(summary.count);

  const parts = [
    `${summary.count} ${pluralize(summary.count, 'checkpoint')}`,
    `latest: ${latest}`,
    summary.preFinalReviewId ? `pre-final-review: ${summary.preFinalReviewId}` : null,
    summary.latestRunCheckpointId && summary.latestRunCheckpointId !== summary.latestId
      ? `latest run: ${summary.latestRunCheckpointId}`
      : null,
    runStatus ? `run status: ${runStatus}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(' | ');
}

export function SummaryCheckpoints({ checkpointSummary }: SummaryCheckpointsProps) {
  const theme = useTheme();
  const isSmall = terminalSizeStore.use((s) => s.isSmall);

  if (!checkpointSummary) return null;

  const latest = formatLatestCheckpoint(checkpointSummary, 88, isSmall);
  const runStatus = formatRunStatus(checkpointSummary);
  const diffCommand = commandFor(checkpointSummary.diffCommand, 'diff', checkpointSummary.latestId);
  const restoreCommand = commandFor(
    checkpointSummary.restoreCommand,
    'restore',
    checkpointSummary.latestId,
  );
  const summaryText = checkpointSummaryText(checkpointSummary, latest, runStatus, isSmall);
  const runStatusColor =
    runStatus === 'rejected'
      ? theme.warning
      : runStatus === 'accepted'
        ? theme.success
        : theme.textDim;

  return (
    <Box flexDirection="column" marginTop={isSmall ? 0 : 1}>
      <Text color={theme.textDim}>
        <Text bold color={theme.text}>
          Checkpoints:
        </Text>{' '}
        {summaryText}
      </Text>
      {isSmall && <Text color={theme.textDim}>latest: {checkpointSummary.latestId ?? 'n/a'}</Text>}
      {isSmall && checkpointSummary.preFinalReviewId && (
        <Text color={theme.textDim}>pre: {checkpointSummary.preFinalReviewId}</Text>
      )}
      {isSmall &&
        checkpointSummary.latestRunCheckpointId &&
        checkpointSummary.latestRunCheckpointId !== checkpointSummary.latestId && (
          <Text color={theme.textDim}>latest run: {checkpointSummary.latestRunCheckpointId}</Text>
        )}
      {isSmall && runStatus && <Text color={runStatusColor}>run status: {runStatus}</Text>}
      {diffCommand && <Text color={theme.textDim}>diff: {diffCommand}</Text>}
      {restoreCommand && <Text color={theme.textDim}>restore: {restoreCommand}</Text>}
      <Text color={runStatus === 'rejected' ? runStatusColor : theme.textDim}>
        restore: hash-guarded; conflicts skipped{isSmall ? '' : ' by default'}; --force destructive
        overwrite
      </Text>
    </Box>
  );
}
