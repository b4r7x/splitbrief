import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { countNoun } from '../../utils/pluralize.js';
import type { StartPreparationState } from './use-start-preparation.js';

const MAX_VISIBLE_CHECKS = 4;

export type StartPreparationPanelProps = Readonly<{
  state: StartPreparationState;
  onRetry: () => void;
  onBack: () => void;
  onOpenSettings: () => void;
  approvalPrompt?: ReactNode | undefined;
}>;

function prioritizedChecks(report: ReadinessReport | undefined): ReadinessCheck[] {
  if (!report) return [];
  const checks = report.sections
    .flatMap((section) => section.checks)
    .filter((check) => check.severity === 'blocker' || check.severity === 'warning');
  return checks.sort((left, right) => {
    if (left.severity === right.severity) return 0;
    return left.severity === 'blocker' ? -1 : 1;
  });
}

export function StartPreparationPanel({
  state,
  onRetry,
  onBack,
  onOpenSettings,
  approvalPrompt,
}: StartPreparationPanelProps) {
  const t = useTheme();
  const hasOverlay = overlayStore.use((snapshot) => snapshot.active !== 'none');
  const hasApprovalPrompt = approvalPrompt !== undefined && approvalPrompt !== null;
  const actionable = state.kind === 'blocked' || state.kind === 'failed';

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (!actionable) return;
      if (input === 'r' || input === 'R') {
        onRetry();
        return;
      }
      if (input === 's' || input === 'S') onOpenSettings();
    },
    { isActive: state.kind !== 'idle' && !hasOverlay && !hasApprovalPrompt },
  );

  if (hasApprovalPrompt) return approvalPrompt;
  if (state.kind === 'idle') return null;

  if (state.kind === 'preparing') {
    return (
      <OverlayPanel title="Preparing your tools…" maxWidth={72} hint="esc back">
        <Text color={t.textDim}>Checking your configured runners before continuing.</Text>
      </OverlayPanel>
    );
  }

  const report = state.report;
  const checks = prioritizedChecks(report);
  const visibleChecks = checks.slice(0, MAX_VISIBLE_CHECKS);
  const hiddenCount = checks.length - visibleChecks.length;
  const failed = state.kind === 'failed';

  return (
    <OverlayPanel
      title={`Tool preparation${SOFT_SEP}${failed ? 'Failed' : 'Blocked'}`}
      maxWidth={72}
      hint={`r retry${SOFT_SEP}esc back${SOFT_SEP}s settings`}
    >
      {report ? (
        <Box justifyContent="space-between">
          <Text color={failed ? t.error : t.warning}>
            {failed ? 'Preparation failed' : 'Start is blocked'}
          </Text>
          <Text color={t.textDim}>
            {countNoun(report.counts.blocker, 'blocker')}
            {SOFT_SEP}
            {countNoun(report.counts.warning, 'warning')}
          </Text>
        </Box>
      ) : (
        <Text color={t.error}>Preparation failed</Text>
      )}

      {failed ? (
        <Box marginTop={1}>
          <Text color={t.textDim}>{sanitizeTerminalDisplayText(state.error.message)}</Text>
        </Box>
      ) : null}

      {visibleChecks.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {visibleChecks.map((check) => (
            <PreparationCheck key={check.id} check={check} />
          ))}
          {hiddenCount > 0 ? (
            <Text color={t.textDim}>{`${countNoun(hiddenCount, 'check')} hidden`}</Text>
          ) : null}
        </Box>
      ) : null}
    </OverlayPanel>
  );
}

function PreparationCheck({ check }: { check: ReadinessCheck }) {
  const t = useTheme();
  const color = check.severity === 'blocker' ? t.error : t.warning;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={color}>{check.severity}</Text>
        {'  '}
        <Text>
          {sanitizeTerminalDisplayText(check.id)}: {sanitizeTerminalDisplayText(check.summary)}
        </Text>
      </Text>
      {check.fix ? (
        <Text color={t.textDim}>
          {'  '}fix
          {SOFT_SEP}
          {sanitizeTerminalDisplayText(check.fix)}
        </Text>
      ) : null}
    </Box>
  );
}
