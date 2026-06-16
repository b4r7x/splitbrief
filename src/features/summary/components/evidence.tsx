import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { truncateWithEllipsis } from '../../../utils/truncate.js';
import { statusGlyph } from '../../../components/task-status-glyph.js';

interface SummaryEvidenceProps {
  summary: Summary;
  ledger?: EvidenceLedger | null;
}

export function SummaryEvidence({ summary, ledger }: SummaryEvidenceProps) {
  const theme = useTheme();
  const isSmall = terminalSizeStore.use((s) => s.isSmall);
  if (!summary.evidenceSummary) return null;

  const truncate = isSmall ? 28 : 60;
  const titleWidth = isSmall ? 18 : 26;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={theme.text}>
        Evidence
      </Text>
      <Text color={theme.textDim} wrap={isSmall ? 'truncate-end' : undefined}>
        ledger: {summary.evidenceSummary.path} ·{' '}
        {summary.evidenceSummary.tasksWithValidationEvidence}/{summary.evidenceSummary.totalTasks}{' '}
        validated · {summary.evidenceSummary.escalatedTasks} escalated ·{' '}
        {summary.evidenceSummary.failedTasks} failed
      </Text>

      {ledger?.tasks.map((task) => {
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
            ? truncateWithEllipsis(task.expectedEvidence.join('; '), truncate)
            : '—';
        const observed =
          task.observedEvidence.length > 0
            ? truncateWithEllipsis(task.observedEvidence.join('; '), truncate)
            : '—';
        return (
          <Box key={task.id} flexDirection={isSmall ? 'column' : 'row'} marginTop={isSmall ? 1 : 0}>
            <Box width={isSmall ? undefined : titleWidth}>
              <Text color={theme.textDim}>
                {statusGlyph(task.escalated ? 'escalated' : task.status)} {task.id}
              </Text>
              <Text> </Text>
              <Text>{truncateWithEllipsis(task.title, isSmall ? 24 : titleWidth - 6)}</Text>
            </Box>
            <Box flexDirection="column" overflow={isSmall ? 'hidden' : undefined}>
              <Text color={theme.textDim} wrap={isSmall ? 'truncate-end' : undefined}>
                passed: {passed}
              </Text>
              {retries && (
                <Text color={theme.textDim} wrap={isSmall ? 'truncate-end' : undefined}>
                  retries: {retries}
                </Text>
              )}
              <Text color={theme.textDim} wrap={isSmall ? 'truncate-end' : undefined}>
                expected: {expected}
              </Text>
              <Text color={theme.textDim} wrap={isSmall ? 'truncate-end' : undefined}>
                observed: {observed}
              </Text>
            </Box>
          </Box>
        );
      })}

      {ledger?.finalReview && (
        <Box marginTop={1} overflow={isSmall ? 'hidden' : undefined}>
          <Text color={theme.textDim} wrap={isSmall ? 'truncate-end' : undefined}>
            final review: {ledger.finalReview.status} ({ledger.finalReview.path})
          </Text>
        </Box>
      )}
    </Box>
  );
}
