import { Text } from 'ink';
import { LabeledRow } from '../../../components/labeled-row.js';
import type { ReviewPacketSummary, Summary } from '../../../core/schemas/summary.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document.js';
import type { Theme } from '../../../components/theme.js';
import { DIPTYCH_DIR } from '../../../core/paths.js';
import { truncateWithEllipsis } from '../../../utils/truncate.js';
import { formatScoreSummary } from '../../../core/formatting.js';

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

  return `${status} · ${formatScoreSummary(summary.driftSummary.score, summary.driftSummary)}`;
}

function formatCompactDriftStatus(packet: ReviewPacketSummary): string {
  if (packet.driftPassed === null) return 'n/a';
  return packet.driftPassed ? 'passed' : 'failed';
}

function finalReviewColor(status: string, warningColor: string, dimColor: string): string {
  return status === 'written' ? dimColor : warningColor;
}

export function buildReviewPacketDetailRows(
  summary: Summary,
  sessionId: string | undefined,
  isSmall: boolean,
  theme: Theme,
): ScrollableDocumentRow[] {
  const packet = summary.reviewPacket;
  if (!packet) return [];

  const pathMaxLength = isSmall ? 30 : 88;
  const markdownPath = compactPath(sessionPath(packet.markdownPath, sessionId), pathMaxLength);
  const jsonPath = compactPath(sessionPath(packet.jsonPath, sessionId), pathMaxLength);
  const finalReviewStatus = formatFinalReviewStatus(packet);
  const driftStatus = formatDriftStatus(packet, summary);
  const driftColor = packet.driftPassed === false ? theme.warning : theme.textDim;
  const artifactColor = packet.missingArtifactCount > 0 ? theme.warning : theme.textDim;

  if (isSmall) {
    return [
      {
        key: 'review-packet-heading',
        node: (
          <LabeledRow label="" labelWidth={0}>
            <Text color={theme.textDim} wrap="truncate-end">
              Review packet:
            </Text>
          </LabeledRow>
        ),
      },
      {
        key: 'review-packet-md',
        node: (
          <LabeledRow label="" labelWidth={0}>
            <Text color={theme.textDim} wrap="truncate-end">
              md: {markdownPath}
            </Text>
          </LabeledRow>
        ),
      },
      {
        key: 'review-packet-json',
        node: (
          <LabeledRow label="" labelWidth={0}>
            <Text color={theme.textDim} wrap="truncate-end">
              json: {jsonPath}
            </Text>
          </LabeledRow>
        ),
      },
      {
        key: 'review-packet-status',
        node: (
          <LabeledRow label="" labelWidth={0}>
            <Text
              color={finalReviewColor(finalReviewStatus, theme.warning, driftColor)}
              wrap="truncate-end"
            >
              final review: {finalReviewStatus} | drift: {formatCompactDriftStatus(packet)} |
              evidence: {packet.evidenceValidatedTasks}/{packet.evidenceTotalTasks}
            </Text>
          </LabeledRow>
        ),
      },
      {
        key: 'review-packet-artifacts',
        node: (
          <LabeledRow label="" labelWidth={0}>
            <Text color={artifactColor} wrap="truncate-end">
              missing: {packet.missingArtifactCount} | checklist
            </Text>
          </LabeledRow>
        ),
      },
    ];
  }

  return [
    {
      key: 'review-packet-heading',
      node: (
        <LabeledRow label="" labelWidth={0}>
          <Text color={theme.textDim} wrap="truncate-end">
            Review packet:
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'review-packet-md',
      node: (
        <LabeledRow label="" labelWidth={0}>
          <Text color={theme.textDim} wrap="truncate-end">
            md: {markdownPath}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'review-packet-json',
      node: (
        <LabeledRow label="" labelWidth={0}>
          <Text color={theme.textDim} wrap="truncate-end">
            json: {jsonPath}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'review-packet-status',
      node: (
        <LabeledRow label="" labelWidth={0}>
          <Text
            color={finalReviewColor(finalReviewStatus, theme.warning, driftColor)}
            wrap="truncate-end"
          >
            final review: {finalReviewStatus} | drift: {driftStatus} | evidence:{' '}
            {packet.evidenceValidatedTasks}/{packet.evidenceTotalTasks} validated
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'review-packet-artifacts',
      node: (
        <LabeledRow label="" labelWidth={0}>
          <Text color={artifactColor} wrap="truncate-end">
            missing artifacts: {packet.missingArtifactCount} | next: open packet/checklist
          </Text>
        </LabeledRow>
      ),
    },
  ];
}
