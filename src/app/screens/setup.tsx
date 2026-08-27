import { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { ListViewport } from '../../components/pickers/list-viewport.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { glyph } from '../../lib/glyphs.js';
import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { type CrewRow, crewRowKey } from '../../core/crew/rows.js';
import type { Config } from '../../core/schemas/config.js';
import { type OverlayDensity, overlayRect } from '../../core/navigation/overlay-rect.js';
import {
  INITIALIZING_TOOLS_BODY,
  INITIALIZING_TOOLS_TITLE,
  REFRESHING_TOOLS_TITLE,
} from '../../core/discovery/copy.js';
import { prepareExecution } from '../../engine/runners/prepare-execution.js';
import {
  CREW_MARKER_GUTTER,
  CREW_RAIL_WIDTH,
  planSeatBlock,
  type SeatBlockLayout,
} from '../../features/crew/format.js';
import { crewActivate } from '../../features/crew/rows.js';
import { PresetRowView } from '../../features/crew/preset-row.js';
import { CrewRowView, CrewSpine, CrewVerdictLine } from '../../features/crew/row-view.js';
import { useCrew } from '../../features/crew/use-crew.js';
import { useFilterableList } from '../../hooks/use-filterable-list.js';
import { refreshPickerDetection } from '../../features/runners/refresh-detection.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import { StartPreparationPanel } from '../../features/start-preparation/panel.js';
import { observePreparationCleanup } from '../../features/start-preparation/observe-cleanup.js';
import { useStartPreparation } from '../../features/start-preparation/use-start-preparation.js';
import { approvalPromptStore, closeApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionSelectStore } from '../../stores/navigation/session-select.js';
import { configStore } from '../../stores/project/config.js';
import { reportConfigSaveFailure } from '../../stores/project/save-feedback.js';
import { detectionStore } from '../../stores/project/detection.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getTerminalCellWidth, sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { assertNever } from '../../utils/type-guards.js';
import { appPreparationError, interactivePreparationPolicy } from '../prepare-resume.js';

type Step = 'discovery' | 'crew';

const CREW_PANEL_DENSITY: OverlayDensity = 'wide';
/** The title with the blank line under it, and the hint with the blank line above it. */
const PANEL_CHROME_ROWS = 4;
/** The note line and the blank line under it. */
const NOTE_BLOCK_ROWS = 2;
export const PRESET_SECTION = 'Ready-made crews';
const CREW_SECTION = 'Crew';
const CONTINUE_SECTION = '';

type SetupItem =
  | Readonly<{ kind: 'preset'; preset: CrewPreset; key: string }>
  | Readonly<{ kind: 'crew'; row: CrewRow; key: string }>
  | Readonly<{ kind: 'continue'; key: string }>;

/**
 * The panel yields in one order until it fits: the cross-lab verdict and the rail spines first
 * (inside `planSeatBlock`), then the section headers, then the blank rows between blocks, then the
 * ready-made crews.
 */
const LADDER = [
  { headers: true, gaps: true, presets: true },
  { headers: false, gaps: true, presets: true },
  { headers: false, gaps: false, presets: true },
  { headers: false, gaps: false, presets: false },
] as const;

type SetupListPlan = Readonly<{
  layout: SeatBlockLayout;
  showPresets: boolean;
  showHeaders: boolean;
  showGaps: boolean;
}>;

type SetupListInput = Readonly<{
  crewRows: readonly CrewRow[];
  verdict: CrewLabVerdict | undefined;
  presets: readonly CrewPreset[];
  innerWidth: number;
  budget: number;
}>;

function planStage(
  input: SetupListInput,
  stage: (typeof LADDER)[number],
): Readonly<{ plan: SetupListPlan; rows: number }> {
  const presetRows = stage.presets ? input.presets.length : 0;
  const blocks = presetRows > 0 ? 2 : 1;
  const around = presetRows + (stage.headers ? blocks : 0) + (stage.gaps ? blocks : 0) + 1;
  const layout = planSeatBlock({
    rows: input.crewRows,
    verdict: input.verdict,
    innerWidth: input.innerWidth,
    rowBudget: input.budget - around,
  });
  return {
    plan: {
      layout,
      showPresets: presetRows > 0,
      showHeaders: stage.headers,
      showGaps: stage.gaps,
    },
    rows: layout.rows + around,
  };
}

function planSetupList(input: SetupListInput): SetupListPlan {
  let staged = planStage(input, LADDER[0]);
  for (const stage of LADDER.slice(1)) {
    if (staged.rows <= input.budget) return staged.plan;
    staged = planStage(input, stage);
  }
  return staged.plan;
}

function sectionOf(item: SetupItem): string {
  switch (item.kind) {
    case 'preset':
      return PRESET_SECTION;
    case 'crew':
      return CREW_SECTION;
    case 'continue':
      return CONTINUE_SECTION;
    default:
      return assertNever(item);
  }
}

/** Continue sits on the same left column as the preset and seat labels. */
function continueText(isCursor: boolean): string {
  const gutter = isCursor ? `${glyph('liveBar')} ` : ' '.repeat(CREW_MARKER_GUTTER);
  return `${gutter}${' '.repeat(CREW_RAIL_WIDTH)}Continue`;
}

interface SetupScreenProps {
  prepare?: typeof prepareExecution | undefined;
}

type SetupPreparationInput = Readonly<{
  projectDir: string;
  feature: string;
  plannerContext?: string | undefined;
  allowRepoRunners: boolean;
}>;

type DiscoveryPanelProps = Readonly<{
  state: 'initializing' | 'failed';
  onBack: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}>;

function DiscoveryPanel({ state, onBack, onRetry, onOpenSettings }: DiscoveryPanelProps) {
  const t = useTheme();
  const hasOverlay = overlayStore.use((snapshot) => snapshot.active !== 'none');

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (state !== 'failed') return;
      if (input === 'r' || input === 'R') {
        onRetry();
        return;
      }
      if (input === 's' || input === 'S') onOpenSettings();
    },
    { isActive: !hasOverlay },
  );

  if (state === 'initializing') {
    return (
      <OverlayPanel title={INITIALIZING_TOOLS_TITLE} density="compact" hint="esc quit">
        <Text color={t.textDim}>{INITIALIZING_TOOLS_BODY}</Text>
      </OverlayPanel>
    );
  }

  return (
    <OverlayPanel
      title="Tool check failed"
      density="compact"
      hint={`r retry${SOFT_SEP}esc quit${SOFT_SEP}s settings`}
    >
      <Text color={t.error}>Your configured tools could not be checked.</Text>
      <Box marginTop={1}>
        <Text color={t.textDim}>Retry the check or review runner settings.</Text>
      </Box>
    </OverlayPanel>
  );
}

type CrewStepProps = Readonly<{
  note?: string | undefined;
  onContinue: (config: Config) => void;
  onExit: () => void;
}>;

function CrewStep({ note, onContinue, onExit }: CrewStepProps) {
  const t = useTheme();
  const config = configStore.useConfig();
  const { rows: crewRows, verdict, presets } = useCrew();
  const { cols, rows: terminalRows } = terminalSizeStore.use((state) => state);
  const hasOverlay = overlayStore.use((snapshot) => snapshot.active !== 'none');
  const error = feedbackStore.use((state) => (state.isError ? state.message : null));

  const { innerWidth, innerRows } = overlayRect({
    cols,
    rows: terminalRows,
    density: CREW_PANEL_DENSITY,
  });
  const budget =
    innerRows -
    PANEL_CHROME_ROWS -
    (note === undefined ? 0 : NOTE_BLOCK_ROWS) -
    (error === null ? 0 : 1);
  const { layout, showPresets, showHeaders, showGaps } = planSetupList({
    crewRows,
    verdict,
    presets,
    innerWidth,
    budget,
  });

  const items: SetupItem[] = [
    ...(showPresets
      ? presets.map((preset): SetupItem => ({ kind: 'preset', preset, key: `preset:${preset.id}` }))
      : []),
    ...crewRows.map((row): SetupItem => ({ kind: 'crew', row, key: crewRowKey(row) })),
    { kind: 'continue', key: 'continue' },
  ];
  const presetLabelWidth = Math.max(
    0,
    ...presets.map((preset) => getTerminalCellWidth(preset.label)),
  );
  const planner = readActiveRunner({ config, role: 'planner' });

  const list = useFilterableList<SetupItem>({
    items,
    getKey: (item) => item.key,
    filterFn: () => true,
    shouldAppendChar: () => false,
    customKeys: (_input, key) => key.backspace || key.delete,
    isActive: !hasOverlay,
    pageSize: budget,
    onClose: onExit,
    onSelect: (item) => {
      if (item.kind === 'continue') {
        onContinue(config);
        return;
      }
      crewActivate({ target: item, config });
    },
  });

  return (
    <OverlayPanel
      title="Set up your crew"
      density={CREW_PANEL_DENSITY}
      hint={`↑↓ navigate${SOFT_SEP}⏎ select${SOFT_SEP}esc quit`}
    >
      {note !== undefined && (
        <Box marginBottom={1}>
          <Text color={t.textDim} wrap="truncate-end">
            {note}
          </Text>
        </Box>
      )}
      <ListViewport
        items={list.filtered}
        selectedIndex={list.selectedIndex}
        getKey={(item) => item.key}
        rowBudget={budget}
        section={{
          by: sectionOf,
          renderHeader: (label) => <Text color={t.textDim}>{label}</Text>,
          gapBetweenSections: showGaps,
          headerFor: (label) => showHeaders && label !== CONTINUE_SECTION,
        }}
        decorations={{
          hasBefore: (item, index) =>
            layout.spines &&
            item.kind === 'crew' &&
            item.row.kind === 'seat' &&
            list.filtered[index - 1]?.kind === 'crew',
          renderBefore: () => <CrewSpine />,
          hasAfter: (item, index) =>
            layout.verdict && item.kind === 'crew' && list.filtered[index + 1]?.kind !== 'crew',
          renderAfter: () =>
            verdict === undefined ? null : <CrewVerdictLine verdict={verdict} width={innerWidth} />,
        }}
        renderItem={(item, ctx) => {
          switch (item.kind) {
            case 'preset':
              return (
                <PresetRowView
                  preset={item.preset}
                  isCursor={ctx.isCursor}
                  width={innerWidth}
                  labelWidth={presetLabelWidth}
                />
              );
            case 'crew':
              return (
                <CrewRowView
                  row={item.row}
                  layout={layout}
                  isCursor={ctx.isCursor}
                  width={innerWidth}
                  planner={planner}
                />
              );
            case 'continue':
              return (
                <Text color={ctx.isCursor ? t.accent : t.textDim} bold={ctx.isCursor}>
                  {continueText(ctx.isCursor)}
                </Text>
              );
            default:
              return assertNever(item);
          }
        }}
      />
      {error !== null && (
        <Text color={t.error} wrap="truncate-end">
          {sanitizeTerminalDisplayText(error)}
        </Text>
      )}
    </OverlayPanel>
  );
}

export function SetupScreen({ prepare = prepareExecution }: SetupScreenProps) {
  const { exit } = useApp();
  const projectDir = configStore.use((state) => state.projectDir);
  const refresh = detectionStore.use((state) => state.refresh);
  const readiness = refresh.readiness;
  const onComplete = routerStore.use((state) =>
    state.screen === 'setup' ? state.onComplete : undefined,
  );
  const pendingFeature = routerStore.use((state) =>
    state.screen === 'setup' ? state.feature : undefined,
  );
  const pendingPlannerContext = routerStore.use((state) =>
    state.screen === 'setup' ? state.plannerContext : undefined,
  );
  const pendingAllowRepoRunners = routerStore.use((state) =>
    state.screen === 'setup' ? state.allowRepoRunners : undefined,
  );
  const approvalPending = approvalPromptStore.use((state) => state.status === 'pending');
  const [step, setStep] = useState<Step>('discovery');

  const preparation = useStartPreparation<SetupPreparationInput>({
    prepare: async (input, signal) => {
      const currentConfig = configStore.get().config;
      if (currentConfig === null) {
        return { kind: 'failed', error: appPreparationError.configNotLoaded() };
      }
      return prepare({
        projectDir: input.projectDir,
        feature: input.feature,
        effectiveConfig: currentConfig,
        signal,
        policy: {
          ...interactivePreparationPolicy,
          purpose: 'new-workflow',
          allowRepoRunners: input.allowRepoRunners,
        },
        ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
      });
    },
    onPrepared: (execution) => {
      routerStore.navigate({
        to: 'workflow',
        execution: { kind: 'local', prepared: execution },
      });
    },
  });

  const hasRememberedDiscovery = readiness.fetchedAt !== null;
  const discoveryRefreshing =
    readiness.refreshing || refresh.modelsDev.refreshing || refresh.cliModels.refreshing;
  const warmRefreshFailed =
    hasRememberedDiscovery &&
    !discoveryRefreshing &&
    [readiness, refresh.modelsDev, refresh.cliModels].some(
      (source) =>
        source.outcome === 'failed' || (source.outcome === 'stale' && source.error !== null),
    );
  const effectiveStep = step === 'discovery' && hasRememberedDiscovery ? 'crew' : step;

  useEffect(() => {
    if (step === 'discovery' && readiness.outcome === 'fresh' && !readiness.refreshing) {
      setStep('crew');
    }
  }, [readiness.outcome, readiness.refreshing, step]);

  useEffect(
    () => () => {
      if (sessionSelectStore.get().preparation.kind === 'idle') closeApprovalPrompt();
    },
    [],
  );

  const retryDiscovery = () => {
    if (!projectDir) return;
    void refreshPickerDetection(projectDir);
  };

  const cancelPreparation = () => {
    preparation.cancel(() => {
      closeApprovalPrompt();
      setStep('crew');
    });
  };

  const finalize = async (finalConfig: Config) => {
    if (!projectDir) return;
    const result = await configStore.save(finalConfig);
    if (reportConfigSaveFailure(result)) return;

    if (onComplete === 'workflow' && pendingFeature) {
      observePreparationCleanup(
        preparation.submit({
          projectDir,
          feature: pendingFeature,
          ...(pendingPlannerContext !== undefined && { plannerContext: pendingPlannerContext }),
          allowRepoRunners: pendingAllowRepoRunners ?? false,
        }),
      );
      return;
    }

    routerStore.navigate({ to: 'home' });
  };

  if (preparation.state.kind !== 'idle') {
    return (
      <StartPreparationPanel
        state={preparation.state}
        onRetry={() => observePreparationCleanup(preparation.retry())}
        onBack={cancelPreparation}
        onOpenSettings={() => overlayStore.open('settings')}
        approvalPrompt={approvalPending ? <ApprovalPrompt /> : undefined}
      />
    );
  }

  if (effectiveStep === 'discovery') {
    const coldFailed = readiness.outcome === 'failed' && !readiness.refreshing;
    return (
      <DiscoveryPanel
        state={coldFailed ? 'failed' : 'initializing'}
        onBack={exit}
        onRetry={retryDiscovery}
        onOpenSettings={() => overlayStore.open('settings')}
      />
    );
  }

  let rememberedStepLabel: string | undefined;
  if (hasRememberedDiscovery && discoveryRefreshing) {
    rememberedStepLabel = `${REFRESHING_TOOLS_TITLE}${SOFT_SEP}remembered results`;
  } else if (warmRefreshFailed) {
    rememberedStepLabel = `Refresh failed${SOFT_SEP}remembered results`;
  }

  return (
    <CrewStep
      {...(rememberedStepLabel !== undefined && { note: rememberedStepLabel })}
      onContinue={(current) => void finalize(current)}
      onExit={exit}
    />
  );
}
