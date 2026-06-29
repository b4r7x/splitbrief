import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { SOFT_SEP, ARROW_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { formatTime } from '../../utils/format-time.js';
import { formatScoreSummary } from '../../core/formatting.js';
import { formatToolModel } from '../../core/model-display.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { Session } from '../../core/schemas/session.js';
import type { EvidenceLedger } from '../../core/schemas/evidence.js';
import { Composer } from '../../components/composer/composer.js';
import { LabeledRow } from '../../components/labeled-row.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { borderStyleFor, glyph } from '../../lib/glyphs.js';
import { ScrollableDocument } from '../../components/scrollable-document.js';
import { SummaryProgress } from './components/progress.js';
import { HeroSavings } from './components/hero-savings.js';
import { buildSummaryDetailRows } from './detail-rows.js';
import { getSummaryDetailViewportHeight } from './detail-layout.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { readEvidenceLedger } from '../../core/evidence/ledger.js';
import { uniqueSorted } from '../../utils/collections.js';
import { assertNever } from '../../utils/type-guards.js';
import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { truncateWithEllipsis } from '../../utils/truncate.js';
import { stripTerminalControls } from '../../utils/display-text.js';

interface SummaryScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
}

function formatImplementerSummary(summary: Summary): string | null {
  if (!summary.implementerTool) return null;

  const taskImplementers = summary.taskBreakdown
    ?.filter(
      (task) =>
        task.tool !== undefined ||
        task.model !== undefined ||
        task.implementerProfile !== undefined,
    )
    .map(
      (task) => `${task.implementerProfile ?? ''}\u0000${task.tool ?? ''}\u0000${task.model ?? ''}`,
    );

  const uniqueTaskImplementers = new Set(taskImplementers ?? []);
  if (uniqueTaskImplementers.size > 1) {
    const profiles = uniqueSorted(
      summary.taskBreakdown
        ?.map((task) => task.implementerProfile)
        .filter((profile): profile is string => profile !== undefined) ?? [],
    );
    return profiles.length > 0
      ? stripTerminalControls(`mixed profiles (${profiles.join(', ')})`)
      : 'mixed implementers';
  }

  return stripTerminalControls(formatToolModel(summary.implementerTool, summary.implementerModel));
}

interface SummaryHeading {
  word: string;
  color: string;
  marker: boolean;
}

function getSummaryHeading(
  status: Session['status'],
  theme: ReturnType<typeof useTheme>,
): SummaryHeading {
  switch (status) {
    case 'complete':
      return { word: 'complete', color: theme.success, marker: true };
    case 'failed':
      return { word: 'failed', color: theme.error, marker: false };
    case 'interrupted':
      return { word: 'interrupted', color: theme.warning, marker: false };
    default:
      return assertNever(status);
  }
}

function formatRouteSummary(summary: Summary, implementerSummary: string | null): string | null {
  const plannerSummary = summary.plannerTool
    ? stripTerminalControls(formatToolModel(summary.plannerTool, summary.plannerModel))
    : null;
  if (!plannerSummary && !implementerSummary) return null;
  if (!plannerSummary) return implementerSummary;
  if (!implementerSummary) return plannerSummary;
  return `${plannerSummary}${ARROW_SEP}${implementerSummary}`;
}

function compactCount(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function compactPacketPath(path: string): string {
  const clean = stripTerminalControls(path);
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? clean : clean.slice(slash + 1);
}

function SummaryCompactRunDetails({
  summary,
  routeSummary,
}: {
  summary: Summary;
  routeSummary: string | null;
}) {
  const theme = useTheme();
  const runParts = [
    summary.mode ?? null,
    formatTime(summary.totalTime),
    summary.briefQuality
      ? formatScoreSummary(summary.briefQuality.score, summary.briefQuality, 'quality')
      : null,
    summary.driftSummary
      ? formatScoreSummary(summary.driftSummary.score, summary.driftSummary)
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <Box flexDirection="column" marginTop={1} overflow="hidden">
      <Text wrap="truncate-end">Feature: {stripTerminalControls(summary.feature)}</Text>
      <Text color={theme.textDim} wrap="truncate-end">
        {routeSummary ? `${routeSummary}${SOFT_SEP}` : ''}
        {runParts.join(SOFT_SEP)}
      </Text>
    </Box>
  );
}

function SummaryCompactLowerSections({
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

interface SummaryEvidenceLedgerState {
  key: string;
  ledger: EvidenceLedger | null;
}

function useSummaryEvidenceLedger(
  summary: Summary | null,
  sessionId: string | undefined,
): EvidenceLedger | null {
  const projectDir = configStore.use((s) => s.projectDir);
  const evidencePath = summary?.evidenceSummary?.path;
  const ledgerKey =
    projectDir && sessionId && evidencePath
      ? `${projectDir}\u0000${sessionId}\u0000${evidencePath}`
      : '';
  const [state, setState] = useState<SummaryEvidenceLedgerState>({ key: '', ledger: null });

  useEffect(() => {
    if (!projectDir || !sessionId || !evidencePath) {
      setState((current) =>
        current.key === ledgerKey && current.ledger === null
          ? current
          : { key: ledgerKey, ledger: null },
      );
      return;
    }

    let ledger: EvidenceLedger | null = null;
    try {
      ledger = readEvidenceLedger(projectDir, sessionId);
    } catch {
      ledger = null;
    }
    setState({ key: ledgerKey, ledger });
  }, [projectDir, sessionId, evidencePath, ledgerKey]);

  return state.key === ledgerKey ? state.ledger : null;
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
  const labelWidth = isSmall ? Math.min(13, Math.max(10, Math.floor(contentWidth / 3))) : 20;
  const taskTitleWidth = Math.max(8, Math.min(isSmall ? 16 : 30, contentWidth - 24));
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
            <Text color={theme.textDim}>press enter to continue</Text>
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
            <Text color={theme.textDim}>diptych </Text>
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
            <LabeledRow label="feature" labelWidth={labelWidth}>
              <Text bold wrap="truncate-end">
                {stripTerminalControls(summary.feature)}
              </Text>
            </LabeledRow>
            {summary.plannerTool && (
              <LabeledRow label="planner" labelWidth={labelWidth}>
                <Text wrap="truncate-end">
                  {stripTerminalControls(
                    formatToolModel(summary.plannerTool, summary.plannerModel),
                  )}
                </Text>
              </LabeledRow>
            )}
            {implementerSummary && (
              <LabeledRow label="implementer" labelWidth={labelWidth}>
                <Text wrap="truncate-end">{implementerSummary}</Text>
              </LabeledRow>
            )}
            <LabeledRow label="brief quality" labelWidth={labelWidth}>
              <Text color={bq && !bq.passed ? theme.warning : theme.textDim} wrap="truncate-end">
                {briefQualityText}
              </Text>
            </LabeledRow>
            {driftText && (
              <LabeledRow label="drift" labelWidth={labelWidth}>
                <Text
                  color={drift && !drift.passed ? theme.warning : theme.textDim}
                  wrap="truncate-end"
                >
                  {driftText}
                </Text>
              </LabeledRow>
            )}
            {summary.chainDriftSummary && (
              <LabeledRow label="drift chain" labelWidth={labelWidth}>
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
              <LabeledRow label="saved" labelWidth={labelWidth}>
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
