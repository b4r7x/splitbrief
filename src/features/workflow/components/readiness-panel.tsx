import { Box, Text, useApp, useInput } from 'ink';
import { OverlayPanel } from '../../../components/overlays/overlay-panel.js';
import { useTheme } from '../../../components/theme.js';
import type { ReadinessCheck, ReadinessReport } from '../../../core/readiness/types.js';
import { pluralize } from '../../../utils/format.js';

interface ReadinessPanelProps {
  report: ReadinessReport;
  onContinue?: () => void;
}

export function ReadinessPanel({ report, onContinue }: ReadinessPanelProps) {
  const t = useTheme();
  const { exit } = useApp();
  const canContinue = report.status !== 'blocked' && onContinue !== undefined;
  const notableChecks = report.sections
    .flatMap((section) => section.checks)
    .filter((check) => check.severity === 'blocker' || check.severity === 'warning')
    .slice(0, 6);

  useInput((input, key) => {
    if ((key.return || input === ' ') && canContinue) {
      onContinue?.();
      return;
    }
    if (key.escape || input === 'q') {
      exit();
    }
  });

  return (
    <OverlayPanel
      title="Run Readiness"
      hint={canContinue ? 'Enter continue · q exit' : 'q exit'}
      maxWidth={86}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text color={statusColor(report.status, t)} bold>
            {report.status} · {report.counts.blocker} blockers · {report.counts.warning} warnings
          </Text>
          <Text color={t.textDim}>
            {report.status === 'blocked'
              ? `Required: ${report.nextAction.label} — ${report.nextAction.reason}`
              : `${report.counts.warning} ${pluralize(report.counts.warning, 'advisory note')}; start can continue.`}
          </Text>
        </Box>
        {notableChecks.length > 0 ? (
          <Box flexDirection="column">
            {notableChecks.map((check) => (
              <ReadinessCheckLine key={check.id} check={check} />
            ))}
          </Box>
        ) : (
          <Text color={t.success}>No readiness blockers or warnings.</Text>
        )}
      </Box>
    </OverlayPanel>
  );
}

function ReadinessCheckLine({ check }: { check: ReadinessCheck }) {
  const t = useTheme();
  const color = check.severity === 'blocker' ? t.error : t.warning;
  return (
    <Box flexDirection="column">
      <Text color={color}>
        {check.severity} {check.id}: {check.summary}
      </Text>
      {check.details?.slice(0, 2).map((detail) => (
        <Text key={detail} color={t.textDim}>
          {' '}
          {detail}
        </Text>
      ))}
      {check.fix && <Text color={t.textDim}> Fix: {check.fix}</Text>}
    </Box>
  );
}

function statusColor(status: ReadinessReport['status'], t: ReturnType<typeof useTheme>): string {
  if (status === 'blocked') return t.error;
  if (status === 'ready-with-warnings') return t.warning;
  return t.success;
}
