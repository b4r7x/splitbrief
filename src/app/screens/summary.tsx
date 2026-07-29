import { Box, Text } from 'ink';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { SOFT_SEP, ARROW_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { formatTime } from '../../utils/format-time.js';
import { formatScoreSummary } from '../../core/formatting.js';
import { formatToolModel } from '../../core/model-display.js';
import { Composer } from '../../components/composer/composer.js';
import { LabeledRow } from '../../components/labeled-row.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { borderStyleFor, glyph } from '../../lib/glyphs.js';
import { ScrollableDocument } from '../../components/scrollable-document.js';
import { SummaryProgress } from '../../features/summary/components/progress.js';
import { HeroSavings } from '../../features/summary/components/hero-savings.js';
import { SummaryCompactRunDetails } from '../../features/summary/components/compact-run-details.js';
import { SummaryCompactLowerSections } from '../../features/summary/components/compact-lower-sections.js';
import { buildSummaryDetailRows } from '../../features/summary/detail-rows.js';
import { getSummaryDetailViewportHeight } from '../../features/summary/detail-layout.js';
import {
  formatImplementerSummary,
  formatRouteSummary,
  getSummaryHeading,
} from '../../features/summary/presentation.js';
import { useSummaryEvidenceLedger } from '../../features/summary/hooks/use-summary-evidence-ledger.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { clamp } from '../../utils/math.js';
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';

interface SummaryScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
}

export function SummaryScreen({ commands, onRuntimeCommand }: SummaryScreenProps) {
  const theme = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const isSmall = terminalSizeStore.use((s) => s.isSmall);
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');

  const summary = routerStore.use((s) => (s.screen === 'summary' ? s.summary : null));
  const sessionId = routerStore.use((s) => (s.screen === 'summary' ? s.sessionId : undefined));
  const status = routerStore.use((s) => (s.screen === 'summary' ? s.status : 'complete'));
  const evidenceLedger = useSummaryEvidenceLedger(summary, sessionId);
  if (!summary) return null;

  const onDone = () => routerStore.navigate({ to: 'home' });

  const completed = summary.completedByLocal + summary.escalatedToPlanner;
  const contentWidth = getResponsivePanelWidth({
    cols,
    size: isSmall ? 'small' : 'large',
    widths: { small: 64, large: 96 },
    gutter: 2,
  });
  const labelWidth = isSmall ? clamp(Math.floor(contentWidth / 3), 10, 13) : 20;
  const taskTitleWidth = clamp(contentWidth - 24, 8, isSmall ? 16 : 30);
  const truncateLength = Math.max(6, taskTitleWidth - 2);
  const mode = summary.mode;
  const isShortSmall = isSmall && cols <= 56 && rows <= 28;

  const bq = summary.briefQuality;
  const drift = summary.driftSummary;
  const briefQualityText = bq ? formatScoreSummary(bq.score, bq, 'quality') : 'quality n/a';
  const driftText = drift ? formatScoreSummary(drift.score, drift) : null;
  const implementerSummary = formatImplementerSummary(summary);
  const routeSummary = formatRouteSummary(summary, implementerSummary);
  const heading = getSummaryHeading(status, theme);
  const bylineText = [routeSummary, mode, formatTime(summary.totalTime)]
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(SOFT_SEP);
  const detailRows = buildSummaryDetailRows({
    summary,
    evidenceLedger,
    sessionId,
    labelWidth,
    taskTitleWidth,
    truncateLength,
    theme,
    isSmall,
    isShortSmall,
  });
  const detailHeight = getSummaryDetailViewportHeight({
    terminalRows: rows,
    isSmall,
    summary,
    implementerSummary,
    routeSummary,
  });

  return (
    <ScreenShell
      padding={1}
      alignItems="center"
      footer={
        <Box flexDirection="column" width={contentWidth}>
          <Box justifyContent="center" height={1}>
            <Text color={theme.textDim}>Press enter to continue</Text>
          </Box>
          <Composer
            disabled={hasOverlay}
            onSubmit={onDone}
            onEmptySubmit={onDone}
            onRuntimeCommand={onRuntimeCommand}
            commands={commands}
            mode="normal"
            hint=""
            currentScreen="summary"
            width={contentWidth}
          />
        </Box>
      }
    >
      <Box
        flexDirection="column"
        width={contentWidth}
        flexGrow={1}
        minHeight={0}
        overflowY="hidden"
      >
        <Box justifyContent="center" width="100%">
          <Text wrap="truncate-end">
            {heading.marker ? <Text color={theme.success}>{glyph('check')} </Text> : null}
            <Text color={theme.textDim}>{SPLITBRIEF_IDENTITY.displayName} </Text>
            <Text color={heading.color}>{heading.word}</Text>
            {isSmall && routeSummary ? <Text color={theme.textDim}> {routeSummary}</Text> : null}
          </Text>
        </Box>
        {!isSmall && bylineText && (
          <Box justifyContent="center" width="100%">
            <Text color={theme.textDim} wrap="truncate-end">
              {bylineText}
            </Text>
          </Box>
        )}

        <HeroSavings costBreakdown={summary.costBreakdown} />

        {isShortSmall ? (
          <SummaryCompactRunDetails summary={summary} routeSummary={routeSummary} />
        ) : (
          <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
            <LabeledRow label="Feature" labelWidth={labelWidth}>
              <Text bold wrap="truncate-end">
                {stripTerminalControls(summary.feature)}
              </Text>
            </LabeledRow>
            {summary.plannerTool && (
              <LabeledRow label="Planner" labelWidth={labelWidth}>
                <Text wrap="truncate-end">
                  {stripTerminalControls(
                    formatToolModel(summary.plannerTool, summary.plannerModel),
                  )}
                </Text>
              </LabeledRow>
            )}
            {implementerSummary && (
              <LabeledRow label="Implementer" labelWidth={labelWidth}>
                <Text wrap="truncate-end">{implementerSummary}</Text>
              </LabeledRow>
            )}
            <LabeledRow label="Brief quality" labelWidth={labelWidth}>
              <Text color={bq && !bq.passed ? theme.warning : theme.textDim} wrap="truncate-end">
                {briefQualityText}
              </Text>
            </LabeledRow>
            {driftText && (
              <LabeledRow label="Drift" labelWidth={labelWidth}>
                <Text
                  color={drift && !drift.passed ? theme.warning : theme.textDim}
                  wrap="truncate-end"
                >
                  {driftText}
                </Text>
              </LabeledRow>
            )}
            {summary.chainDriftSummary && (
              <LabeledRow label="Drift chain" labelWidth={labelWidth}>
                <Text color={theme.textDim} wrap="truncate-end">
                  {summary.chainDriftSummary.chainLength} tasks{ARROW_SEP}
                  {stripTerminalControls(summary.chainDriftSummary.representativePath)}
                  {SOFT_SEP}
                  {summary.chainDriftSummary.score.toFixed(2)}
                  {summary.chainDriftSummary.emittedChainCount > 1
                    ? `${SOFT_SEP}${summary.chainDriftSummary.emittedChainCount} chains`
                    : ''}
                </Text>
              </LabeledRow>
            )}
            {!summary.costBreakdown && summary.estimatedCostSavings !== 'unavailable' && (
              <LabeledRow label="Saved" labelWidth={labelWidth}>
                <Text bold color={theme.success} wrap="truncate-end">
                  {stripTerminalControls(summary.estimatedCostSavings)}
                </Text>
              </LabeledRow>
            )}
          </Box>
        )}

        <SummaryProgress
          completed={completed}
          total={summary.totalTasks}
          completedByLocal={summary.completedByLocal}
          failed={summary.failed}
          isSmall={isSmall}
        />

        {isShortSmall ? (
          <SummaryCompactLowerSections summary={summary} ledger={evidenceLedger} />
        ) : detailRows.length > 0 ? (
          <Box
            flexDirection="column"
            width={contentWidth}
            marginTop={1}
            borderStyle={borderStyleFor('single')}
            borderColor={theme.border}
            borderDimColor
            overflow="hidden"
          >
            <ScrollableDocument
              rows={detailRows}
              height={detailHeight}
              width={contentWidth}
              isActive={!hasOverlay}
              showScrollbar
              showScrollIndicators={false}
            />
          </Box>
        ) : null}
      </Box>
    </ScreenShell>
  );
}
