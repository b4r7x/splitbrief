import { Box, Text } from 'ink';
import type { Summary } from '../../../core/schemas/summary.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { useTheme } from '../../../components/theme.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { truncateWithEllipsis } from '../../../utils/truncate.js';
import { compactCount, compactPacketPath } from '../presentation.js';

export function SummaryCompactLowerSections({
  summary,
  ledger,
}: {
  summary: Summary;
  ledger: EvidenceLedger | null;
}) {
  const theme = useTheme();
  const checkpointSummary = summary.checkpointSummary;
  const reviewPacket = summary.reviewPacket;
  const evidence = summary.evidenceSummary;
  if (!evidence && !checkpointSummary && !reviewPacket) return null;

  return (
    <Box flexDirection="column" marginTop={1} overflow="hidden">
      {evidence && (
        <Text color={theme.textDim} wrap="truncate-end">
          <Text bold color={theme.text}>
            Evidence:
          </Text>{' '}
          {compactPacketPath(evidence.path)}
          {SOFT_SEP}
          {evidence.tasksWithValidationEvidence}/{evidence.totalTasks} validated
          {ledger?.finalReview ? `${SOFT_SEP}final review: ${ledger.finalReview.status}` : ''}
        </Text>
      )}
      {checkpointSummary && (
        <Text color={theme.textDim} wrap="truncate-end">
          <Text bold color={theme.text}>
            Checkpoints:
          </Text>{' '}
          {compactCount(checkpointSummary.count, 'ckpt')}
          {SOFT_SEP}latest: {stripTerminalControls(checkpointSummary.latestId ?? 'n/a')}
          {checkpointSummary.preFinalReviewId
            ? `${SOFT_SEP}pre: ${stripTerminalControls(checkpointSummary.preFinalReviewId)}`
            : ''}
        </Text>
      )}
      {reviewPacket && (
        <>
          <Text color={theme.textDim} wrap="truncate-end">
            <Text bold color={theme.text}>
              Review packet:
            </Text>
          </Text>
          <Text color={theme.textDim} wrap="truncate-end">
            md: {truncateWithEllipsis(compactPacketPath(reviewPacket.markdownPath), 34)}
          </Text>
          <Text color={theme.textDim} wrap="truncate-end">
            json: {truncateWithEllipsis(compactPacketPath(reviewPacket.jsonPath), 32)}
          </Text>
          <Text
            color={reviewPacket.finalReviewStatus === 'written' ? theme.textDim : theme.warning}
            wrap="truncate-end"
          >
            final review: {reviewPacket.finalReviewStatus}
            {SOFT_SEP}evidence: {reviewPacket.evidenceValidatedTasks}/
            {reviewPacket.evidenceTotalTasks}
            {SOFT_SEP}missing: {reviewPacket.missingArtifactCount}
          </Text>
        </>
      )}
    </Box>
  );
}
