import { Box, Text, useApp, useInput } from 'ink';
import { SOFT_SEP } from '../../../components/separators.js';
import { borderStyleFor, glyph } from '../../../lib/glyphs.js';
import { useTheme } from '../../../components/theme.js';
import { getClampedTerminalWidth } from '../../../utils/terminal-width.js';
import type { ReadinessCheck, ReadinessReport } from '../../../core/readiness/types.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';
import { Divider } from './divider.js';

const DETAIL_INDENT = '           ';

interface ReadinessPanelProps {
  report: ReadinessReport;
  onOpenFix?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}

export function ReadinessPanel({ report, onOpenFix, onDismiss }: ReadinessPanelProps) {
  const t = useTheme();
  const { exit } = useApp();
  const dismiss = onDismiss ?? exit;
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const notableChecks = report.sections
    .flatMap((section) => section.checks)
    .filter((check) => check.severity === 'blocker' || check.severity === 'warning')
    .slice(0, 6);

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') {
        dismiss();
        return;
      }
      if (key.return) {
        onOpenFix?.();
      }
    },
    { isActive: !hasOverlay },
  );

  const width = getClampedTerminalWidth({ cols, maxWidth: 72 });
  const innerWidth = Math.max(1, width - 4);
  const isBlocked = report.status === 'blocked';

  return (
    <Box width={cols} height={rows} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        width={width}
        borderStyle={borderStyleFor('bold')}
        borderColor={isBlocked ? t.error : t.border}
        paddingX={1}
      >
        {notableChecks.length > 0 ? (
          <>
            <Box justifyContent="space-between">
              <Text>
                Readiness
                <Text color={t.textDim}>{SOFT_SEP}</Text>
                <Text color={isBlocked ? t.error : t.textDim}>
                  {isBlocked ? 'Blocked' : 'Warnings'}
                </Text>
              </Text>
              <Text color={t.textDim}>
                {countNoun(report.counts.blocker, 'blocker')}
                {SOFT_SEP}
                {countNoun(report.counts.warning, 'warning')}
              </Text>
            </Box>
            <Text> </Text>
            <Text>
              <Text color={t.textDim}>{'required  '}</Text>
              <Text bold>{sanitizeTerminalDisplayText(report.nextAction.label)}</Text>
              <Text color={t.textDim}>
                {SOFT_SEP}
                {sanitizeTerminalDisplayText(report.nextAction.reason)}
              </Text>
            </Text>
            <Text> </Text>
            {notableChecks.map((check) => (
              <ReadinessCheckLine key={check.id} check={check} />
            ))}
            <Divider width={innerWidth} tone="textDim" />
            <Text color={t.textDim}>
              {onOpenFix ? `esc dismiss${SOFT_SEP}⏎ open fix` : 'esc dismiss'}
            </Text>
          </>
        ) : (
          <Text>
            <Text color={t.success}>{`${glyph('statusDone')} `}</Text>
            Ready
            <Text color={t.textDim}>
              {SOFT_SEP}
              No blockers, start can continue
            </Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

function ReadinessCheckLine({ check }: { check: ReadinessCheck }) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const showDetails = cols > 50;
  const severityColor = check.severity === 'blocker' ? t.error : t.textDim;
  return (
    <Box flexDirection="column">
      <Text>
        {'  '}
        <Text color={severityColor}>{check.severity}</Text>
        <Text color={t.text}>
          {'  '}
          {check.id}: {sanitizeTerminalDisplayText(check.summary)}
        </Text>
      </Text>
      {showDetails &&
        check.details?.slice(0, 2).map((detail) => (
          <Text key={detail} color={t.textDim}>
            {DETAIL_INDENT}
            {sanitizeTerminalDisplayText(detail)}
          </Text>
        ))}
      {check.fix ? (
        <Text color={t.textDim}>
          {DETAIL_INDENT}fix
          {SOFT_SEP}
          {sanitizeTerminalDisplayText(check.fix)}
        </Text>
      ) : null}
      <Text> </Text>
    </Box>
  );
}
