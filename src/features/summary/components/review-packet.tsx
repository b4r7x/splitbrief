import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import type { ReviewPacketSummary, Summary } from '../../../core/schemas/summary.js';
import { DIPTYCH_DIR } from '../../../core/paths.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { truncateWithEllipsis } from '../../../utils/truncate.js';
import { pluralize } from '../../../utils/format.js';

interface SummaryReviewPacketProps {
  summary: Summary;
  sessionId?: string | undefined;
}

function sessionPath(path: string, sessionId: string | undefined): string {
  if (path.includes('/')) return path;
  return sessionId ? `${DIPTYCH_DIR}/sessions/${sessionId}/${path}` : path;
}

function compactPath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) return truncateWithEllipsis(path, maxLength);

  const fileName = path.slice(lastSlash + 1);
  const parent = path.slice(0, lastSlash);
  const parentMaxLength = maxLength - fileName.length - 1;
  if (parentMaxLength <= 1) return truncateWithEllipsis(path, maxLength);

  return `${truncateWithEllipsis(parent, parentMaxLength)}/${fileName}`;
}

function formatFinalReviewStatus(packet: ReviewPacketSummary): string {
  if (packet.finalReviewStatus === 'written') return 'written';
  if (packet.finalReviewStatus === 'failed') return 'failed';
  if (packet.finalReviewStatus === 'missing') return 'missing';
  return 'skipped';
}

function formatDriftStatus(packet: ReviewPacketSummary, summary: Summary): string {
  if (packet.driftPassed === null) return 'n/a';

  const status = packet.driftPassed ? 'passed' : 'failed';
  if (!summary.driftSummary) return status;

  const issueText =
    summary.driftSummary.errorCount > 0
      ? ` · ${summary.driftSummary.errorCount} ${pluralize(summary.driftSummary.errorCount, 'error')}`
      : summary.driftSummary.warningCount > 0
        ? ` · ${summary.driftSummary.warningCount} ${pluralize(summary.driftSummary.warningCount, 'warning')}`
        : '';
  return `${status} · score ${summary.driftSummary.score.toFixed(2)}${issueText}`;
}

function formatCompactDriftStatus(packet: ReviewPacketSummary): string {
  if (packet.driftPassed === null) return 'n/a';
  return packet.driftPassed ? 'passed' : 'failed';
}

function finalReviewColor(status: string, warningColor: string, dimColor: string): string {
  return status === 'written' ? dimColor : warningColor;
}

export function SummaryReviewPacket({ summary, sessionId }: SummaryReviewPacketProps) {
  const theme = useTheme();
  const isSmall = terminalSizeStore.use((s) => s.isSmall);
  const packet = summary.reviewPacket;

  if (!packet) return null;

  const pathMaxLength = isSmall ? 30 : 88;
  const markdownPath = compactPath(sessionPath(packet.markdownPath, sessionId), pathMaxLength);
  const jsonPath = compactPath(sessionPath(packet.jsonPath, sessionId), pathMaxLength);
  const finalReviewStatus = formatFinalReviewStatus(packet);
  const driftStatus = formatDriftStatus(packet, summary);
  const driftColor = packet.driftPassed === false ? theme.warning : theme.textDim;
  const artifactColor = packet.missingArtifactCount > 0 ? theme.warning : theme.textDim;

  if (isSmall) {
    return (
      <Box flexDirection="column" marginTop={0}>
        <Text color={theme.textDim}>
          <Text bold color={theme.text}>
            Review packet:
          </Text>
        </Text>
        <Text color={theme.textDim}>md: {markdownPath}</Text>
        <Text color={theme.textDim}>json: {jsonPath}</Text>
        <Text color={finalReviewColor(finalReviewStatus, theme.warning, driftColor)}>
          final review: {finalReviewStatus} | drift: {formatCompactDriftStatus(packet)} | evidence:{' '}
          {packet.evidenceValidatedTasks}/{packet.evidenceTotalTasks} | missing:{' '}
          {packet.missingArtifactCount} | checklist
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.textDim}>
        <Text bold color={theme.text}>
          Review packet:
        </Text>{' '}
        md: {markdownPath} | json: {jsonPath}
      </Text>
      <Text color={finalReviewColor(finalReviewStatus, theme.warning, driftColor)}>
        final review: {finalReviewStatus} | drift: {driftStatus} | evidence:{' '}
        {packet.evidenceValidatedTasks}/{packet.evidenceTotalTasks} validated
      </Text>
      <Text color={artifactColor}>
        missing artifacts: {packet.missingArtifactCount} | next: open packet/checklist
      </Text>
    </Box>
  );
}
