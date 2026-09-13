import { Box, Text } from 'ink';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { SOFT_SEP, arrowSep } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { formatTime } from '../../utils/format-time.js';
import { formatScoreSummary } from '../../core/formatting.js';
import { Composer } from '../../components/composer/composer.js';
import { LabeledRow } from '../../components/labeled-row.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { glyph } from '../../lib/glyphs.js';
import {
  ScrollableDocument,
  getScrollableDocumentLineCount,
} from '../../components/scrollable-document.js';
import { SummaryProgress } from '../../features/summary/components/progress.js';
import { HeroSavings } from '../../features/summary/components/hero-savings.js';
import { SummaryCompactRunDetails } from '../../features/summary/components/compact-run-details.js';
import { SummaryCompactLowerSections } from '../../features/summary/components/compact-lower-sections.js';
import { buildSummaryDetailRows } from '../../features/summary/detail-rows.js';
import { getSummaryDetailViewportHeight } from '../../features/summary/detail-layout.js';
import {
  formatImplementerSummary,
  formatPlannerSummary,
  formatReviewerSummary,
  formatRouteSummary,
  getSummaryHeading,
  summarizeOutcome,
} from '../../features/summary/presentation.js';
import { useSummaryEvidenceLedger } from '../../features/summary/hooks/use-summary-evidence-ledger.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { clamp } from '../../utils/math.js';
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';
import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import { overlayWidth } from '../../core/navigation/overlay-rect.js';

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
  const contentWidth = overlayWidth({ cols, density: 'roomy' });
  const outcome = summarizeOutcome(summary, status, {
    compact: isSmall || rows <= 28,
    width: contentWidth,
  });
  const labelWidth = isSmall ? clamp(Math.floor(contentWidth / 3), 10, 13) : 20;
  const taskTitleWidth = clamp(contentWidth - 24, 8, isSmall ? 16 : 30);
  const truncateLength = Math.max(6, taskTitleWidth - 2);
  const mode = summary.mode;
  const isShortSmall = isSmall && cols <= 56 && rows <= 28;

  const bq = summary.briefQuality;
  const drift = summary.driftSummary;
  const briefQualityText = bq ? formatScoreSummary(bq.score, bq, 'quality') : null;
  const driftText = drift ? formatScoreSummary(drift.score, drift) : null;
  const plannerSummary = formatPlannerSummary(summary);
  const implementerSummary = formatImplementerSummary(summary);
  const routeSummary = formatRouteSummary(summary, implementerSummary);
  const reviewerSummary = formatReviewerSummary(summary);
  const heading = getSummaryHeading(status, theme, outcome.ready);
  const bylineMetaText = [mode, formatTime(summary.totalTime)]
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
    outcomeRows: 1 + outcome.facts.length + (outcome.next === '' ? 0 : 1),
    isSmall,
    summary,
    implementerSummary,
    reviewerSummary,
    routeSummary,
  });
  const detailViewportHeight = Math.min(detailHeight, getScrollableDocumentLineCount(detailRows));
  const ledgerRule = glyph('divider').repeat(Math.max(0, contentWidth));

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
            <Text color={heading.color}>{glyph(heading.glyph)} </Text>
            <Text color={theme.textDim}>{SPLITBRIEF_IDENTITY.displayName} </Text>
            <Text bold color={heading.color}>
              {heading.word}
            </Text>
          </Text>
        </Box>
        {/* What the run left behind, in the order a reader asks it. The heading says how it ended;
            these say whether anything still needs doing about it. */}
        <Box flexDirection="column" alignItems="center" width="100%" flexShrink={0}>
          <Text wrap="truncate-end" bold color={outcome.ready ? theme.success : theme.warning}>
            {outcome.headline}
          </Text>
          {outcome.facts.map((fact) => (
            <Text key={fact} wrap="truncate-end" color={theme.textDim}>
              {fact}
            </Text>
          ))}
          {outcome.next === '' ? null : (
            <Text wrap="truncate-end" color={theme.textDim}>
              {outcome.next}
            </Text>
          )}
        </Box>

        {/* The crew is three labelled rows below, at every width: an arrow chain here would say it
            a second way, and the chain has no row for a reviewer that inherits. */}
        {!isSmall && bylineMetaText !== '' && (
          <Box justifyContent="center" width="100%">
            <Text wrap="truncate-end" color={theme.textDim}>
              {bylineMetaText}
            </Text>
          </Box>
        )}

        {isShortSmall ? (
          <SummaryCompactRunDetails summary={summary} routeSummary={routeSummary} />
        ) : (
          <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
            <LabeledRow label="Feature" labelWidth={labelWidth}>
              <Text bold wrap="truncate-end">
                {stripTerminalControls(summary.feature)}
              </Text>
            </LabeledRow>
            {plannerSummary && (
              <LabeledRow
                label={CREW_SEAT_LABELS.plan}
                labelWidth={labelWidth}
                labelColor={theme.planner}
              >
                <Text wrap="truncate-end">{plannerSummary}</Text>
              </LabeledRow>
            )}
            {implementerSummary && (
              <LabeledRow
                label={CREW_SEAT_LABELS.build}
                labelWidth={labelWidth}
                labelColor={theme.implementer}
              >
                <Text wrap="truncate-end">{implementerSummary}</Text>
              </LabeledRow>
            )}
            {reviewerSummary && (
              <LabeledRow
                label={CREW_SEAT_LABELS.review}
                labelWidth={labelWidth}
                labelColor={theme.reviewer}
              >
                <Text wrap="truncate-end">{reviewerSummary}</Text>
              </LabeledRow>
            )}
            {briefQualityText && (
              <LabeledRow label="Brief quality" labelWidth={labelWidth}>
                <Text color={bq && !bq.passed ? theme.warning : theme.textDim} wrap="truncate-end">
                  {briefQualityText}
                </Text>
              </LabeledRow>
            )}
            {driftText && (
              <LabeledRow label="Scope" labelWidth={labelWidth}>
                <Text
                  color={drift && !drift.passed ? theme.warning : theme.textDim}
                  wrap="truncate-end"
                >
                  {driftText}
                </Text>
              </LabeledRow>
            )}
            {summary.chainDriftSummary && (
              <LabeledRow label="Scope chain" labelWidth={labelWidth}>
                <Text color={theme.textDim} wrap="truncate-end">
                  {summary.chainDriftSummary.chainLength} briefs{arrowSep()}
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

        <HeroSavings costBreakdown={summary.costBreakdown} />

        <SummaryProgress
          completed={completed}
          total={summary.totalTasks}
          completedByLocal={summary.completedByLocal}
          failed={summary.failed}
          isSmall={isSmall}
        />

        {isShortSmall ? (
          <SummaryCompactLowerSections summary={summary} ledger={evidenceLedger} />
        ) : detailRows.length > 0 && detailViewportHeight > 0 ? (
          <Box flexDirection="column" width={contentWidth} marginTop={1} overflow="hidden">
            <Box height={1} overflow="hidden" flexShrink={0}>
              <Text color={theme.border}>{ledgerRule}</Text>
            </Box>
            <ScrollableDocument
              rows={detailRows}
              height={detailViewportHeight}
              width={contentWidth}
              isActive={!hasOverlay}
              showScrollbar
              showScrollIndicators={false}
            />
            <Box height={1} overflow="hidden" flexShrink={0}>
              <Text color={theme.border}>{ledgerRule}</Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    </ScreenShell>
  );
}
