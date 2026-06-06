import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useTheme } from '../../components/theme.js';
import { formatTime } from '../../utils/format-time.js';
import { pluralize } from '../../utils/pluralize.js';
import { formatToolModel } from '../../core/model-display.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { EvidenceLedger } from '../../core/schemas/evidence.js';
import { Composer } from '../../components/composer/composer.js';
import { LabeledRow } from '../../components/labeled-row.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { SummaryProgress } from './components/progress.js';
import { SummaryCostBreakdown } from './components/cost-breakdown.js';
import { SummaryTaskTable } from './components/task-table.js';
import { SummaryPhaseTiming } from './components/phase-timing.js';
import { SummaryEvidence } from './components/evidence.js';
import { SummaryCheckpoints } from './components/checkpoints.js';
import { SummaryReviewPacket } from './components/review-packet.js';
import { HeroSavings } from './components/hero-savings.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { readEvidenceLedger } from '../../core/evidence/ledger.js';
import { uniqueSorted } from '../../utils/collections.js';

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
    return profiles.length > 0 ? `mixed profiles (${profiles.join(', ')})` : 'mixed implementers';
  }

  return formatToolModel(summary.implementerTool, summary.implementerModel);
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

    const ledger = readEvidenceLedger(projectDir, sessionId);
    setState({ key: ledgerKey, ledger });
  }, [projectDir, sessionId, evidencePath, ledgerKey]);

  return state.key === ledgerKey ? state.ledger : null;
}

export function SummaryScreen({ commands, onRuntimeCommand }: SummaryScreenProps) {
  const theme = useTheme();
  const isSmall = terminalSizeStore.use((s) => s.isSmall);

  const summary = routerStore.use((s) => (s.screen === 'summary' ? s.summary : null));
  const sessionId = routerStore.use((s) => (s.screen === 'summary' ? s.sessionId : undefined));
  const evidenceLedger = useSummaryEvidenceLedger(summary, sessionId);
  if (!summary) return null;

  const onDone = () => routerStore.navigate({ to: 'home' });

  const completed = summary.completedByLocal + summary.escalatedToPlanner;
  const labelWidth = isSmall ? 15 : 20;
  const taskTitleWidth = isSmall ? 20 : 30;
  const truncateLength = isSmall ? 18 : 28;
  const mode = summary.mode;
  const compiledByPlannerCount = summary.totalTasks;
  const localCount = summary.completedByLocal;
  const escalatedCount = summary.escalatedToPlanner;

  const bq = summary.briefQuality;
  const drift = summary.driftSummary;
  const briefQualityText = bq
    ? `quality ${bq.score.toFixed(2)}${bq.errorCount > 0 ? ` · ${bq.errorCount} ${pluralize(bq.errorCount, 'error')}` : ''}${bq.warningCount > 0 ? ` · ${bq.warningCount} ${pluralize(bq.warningCount, 'warning')}` : ''}`
    : 'quality n/a';
  const driftText = drift
    ? `score ${drift.score.toFixed(2)}${drift.warningCount > 0 ? ` · ${drift.warningCount} ${pluralize(drift.warningCount, 'warning')}` : ''}${drift.errorCount > 0 ? ` · ${drift.errorCount} ${pluralize(drift.errorCount, 'error')}` : ''}`
    : null;
  const implementerSummary = formatImplementerSummary(summary);

  return (
    <ScreenShell padding={1}>
      <Box justifyContent="center" width="100%">
        <Text bold color={theme.success}>
          diptych complete
        </Text>
      </Box>
      <Box justifyContent="center" width="100%">
        <Text color={theme.textDim}>
          Planner compiled {compiledByPlannerCount} Task{' '}
          {compiledByPlannerCount === 1 ? 'Brief' : 'Briefs'} · Implementer completed {localCount}{' '}
          locally{escalatedCount > 0 ? ` · ${escalatedCount} escalated` : ''}
        </Text>
      </Box>

      <HeroSavings costBreakdown={summary.costBreakdown} />

      <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
        <LabeledRow label="Feature" labelWidth={labelWidth}>
          <Text bold>{summary.feature}</Text>
        </LabeledRow>
        <LabeledRow label="Time" labelWidth={labelWidth}>
          <Text>{formatTime(summary.totalTime)}</Text>
        </LabeledRow>
        {summary.plannerTool && (
          <LabeledRow label="Planner" labelWidth={labelWidth}>
            <Text>{formatToolModel(summary.plannerTool, summary.plannerModel)}</Text>
          </LabeledRow>
        )}
        {implementerSummary && (
          <LabeledRow label="Implementer" labelWidth={labelWidth}>
            <Text>{implementerSummary}</Text>
          </LabeledRow>
        )}
        {mode && (
          <LabeledRow label="Mode" labelWidth={labelWidth}>
            <Text>{mode}</Text>
          </LabeledRow>
        )}
        <LabeledRow label="Brief quality" labelWidth={labelWidth}>
          <Text color={bq && !bq.passed ? theme.warning : theme.textDim}>{briefQualityText}</Text>
        </LabeledRow>
        {driftText && (
          <LabeledRow label="Drift" labelWidth={labelWidth}>
            <Text color={drift && !drift.passed ? theme.warning : theme.textDim}>{driftText}</Text>
          </LabeledRow>
        )}
        {summary.chainDriftSummary && (
          <Box marginTop={1}>
            <Text color={theme.textDim}>
              Drift chain: {summary.chainDriftSummary.chainLength} tasks writing to{' '}
              {summary.chainDriftSummary.representativePath}, score{' '}
              {summary.chainDriftSummary.score.toFixed(2)}
              {summary.chainDriftSummary.emittedChainCount > 1
                ? ` (${summary.chainDriftSummary.emittedChainCount} chains total)`
                : ''}
            </Text>
          </Box>
        )}
        {!summary.costBreakdown && summary.estimatedCostSavings !== 'unavailable' && (
          <LabeledRow label="Saved" labelWidth={labelWidth}>
            <Text bold color={theme.success}>
              {summary.estimatedCostSavings}
            </Text>
          </LabeledRow>
        )}
      </Box>

      <SummaryProgress
        completed={completed}
        total={summary.totalTasks}
        completedByLocal={summary.completedByLocal}
        escalatedToPlanner={summary.escalatedToPlanner}
        failed={summary.failed}
        isSmall={isSmall}
      />

      {summary.costBreakdown && (
        <SummaryCostBreakdown
          costBreakdown={summary.costBreakdown}
          labelWidth={labelWidth}
          isSmall={isSmall}
        />
      )}

      {summary.taskBreakdown && (
        <SummaryTaskTable
          tasks={summary.taskBreakdown}
          taskTitleWidth={taskTitleWidth}
          truncateLength={truncateLength}
        />
      )}

      {summary.evidenceSummary && <SummaryEvidence summary={summary} ledger={evidenceLedger} />}

      <SummaryCheckpoints checkpointSummary={summary.checkpointSummary} />

      <SummaryReviewPacket summary={summary} sessionId={sessionId} />

      {summary.phaseTimings && (
        <SummaryPhaseTiming phaseTimings={summary.phaseTimings} labelWidth={labelWidth} />
      )}

      <Box marginTop={1}>
        <Composer
          onSubmit={onDone}
          onRuntimeCommand={onRuntimeCommand}
          commands={commands}
          mode="normal"
          hint="press enter to continue"
          currentScreen="summary"
        />
      </Box>
    </ScreenShell>
  );
}
