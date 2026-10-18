import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { ListViewport } from '../../components/pickers/list-viewport.js';
import { listRowLead } from '../../components/list-row.js';
import { SOFT_SEP } from '../../core/separators.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { type CrewRow, crewRowKey } from '../../core/crew/rows.js';
import {
  checkCrewAvailability,
  selectDetectedDefaultCrew,
  unavailableCrewSeats,
} from '../../engine/detection/crew.js';
import type { CrewSeat } from '../../core/crew/seats.js';
import type { PickerDetectionSnapshot } from '../../features/runners/model-catalog/status.js';
import type { Config } from '../../core/schemas/config.js';
import type { AttachedInput } from '../../core/schemas/attachment.js';
import { cliSignInStep } from '../../core/schemas/readiness.js';
import { type OverlayDensity, overlayRect } from '../../core/navigation/overlay-rect.js';
import { BOOT_MANIFEST_TITLE, REFRESHING_TOOLS_TITLE } from '../../core/discovery/copy.js';
import { BootManifest } from '../../features/runners/boot-manifest.js';
import { prepareExecution } from '../../engine/runners/prepare-execution/prepare-execution.js';
import {
  CREW_IDENTITY_COLUMN,
  planSeatBlock,
  type SeatBlockLayout,
} from '../../features/crew/format.js';
import { crewActivate } from '../../features/crew/rows.js';
import { PresetRowView } from '../../features/crew/preset-row.js';
import { CrewRowView, CrewVerdictLine } from '../../features/crew/row-view.js';
import { useCrew } from '../../features/crew/use-crew.js';
import { useFilterableList } from '../../hooks/use-filterable-list.js';
import { useSpinnerFrame } from '../../hooks/use-spinner-frame.js';
import { refreshPickerDetection } from '../../features/runners/refresh-detection.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import { StartPreparationPanel } from '../../features/start-preparation/panel.js';
import { observePreparationCleanup } from '../../features/start-preparation/observe-cleanup.js';
import { useStartPreparation } from '../../features/start-preparation/use-start-preparation.js';
import { approvalPromptStore, closeApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { routerStore } from '../../stores/navigation/router.js';
import { preparationStore } from '../../stores/navigation/preparation.js';
import { readRunRecord } from '../../core/sessions/run-record-io.js';
import { sessionSelectStore } from '../../stores/navigation/session-select.js';
import { configStore } from '../../stores/project/config.js';
import { persistedConfigForSave } from '../../stores/project/config-persistence.js';
import { configError } from '../../core/config/errors.js';
import {
  formatConfigSaveSuccess,
  reportConfigSaveFailure,
} from '../../stores/project/save-feedback.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { wrapPathAware } from '../../utils/wrap.js';
import { assertNever } from '../../utils/type-guards.js';
import { isAbortError } from '../../utils/abort.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { FeedbackNotice, layoutFeedbackNotice } from '../../components/feedback-notice.js';
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

/** Setup reads each tool's own model list the way the picker does. */
function withCliCatalogs(detection: PickerDetectionSnapshot): PickerDetectionSnapshot {
  return { ...detection, cliCatalog: (tool) => modelCacheStore.getCliCatalogRuntime({ tool }) };
}

async function unavailableSetupSeats(
  config: Config,
  detection: PickerDetectionSnapshot,
  signal?: AbortSignal,
) {
  const { config: effective, diskConfig: persisted } = configStore.get();
  if (effective === null || persisted === null) throw configError.loadNotCalled('setup');
  const saved = persistedConfigForSave({ persisted, effective, updated: config });
  const crewDetection = withCliCatalogs(detection);
  const [invocationSeats, persistedSeats] = await Promise.all([
    checkCrewAvailability({ config, detection: crewDetection, signal }),
    checkCrewAvailability({ config: saved, detection: crewDetection, signal }),
  ]);
  return [...invocationSeats, ...persistedSeats];
}

type SetupItem =
  | Readonly<{ kind: 'preset'; preset: CrewPreset; key: string }>
  | Readonly<{ kind: 'crew'; row: CrewRow; key: string }>
  | Readonly<{ kind: 'continue'; key: string }>;

/**
 * The panel yields in one order until it fits: the cross-lab verdict first (inside
 * `planSeatBlock`), then the section headers, then the blank rows between blocks and under the
 * sign-in step, then the ready-made crews.
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
  signIn: boolean;
  innerWidth: number;
  budget: number;
}>;

function planStage(
  input: SetupListInput,
  stage: (typeof LADDER)[number],
): Readonly<{ plan: SetupListPlan; rows: number }> {
  const presetRows = stage.presets ? input.presets.length : 0;
  const blocks = presetRows > 0 ? 2 : 1;
  const gaps = blocks + (input.signIn ? 1 : 0);
  const around = presetRows + (stage.headers ? blocks : 0) + (stage.gaps ? gaps : 0) + 1;
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

function crewKeysHint(item: SetupItem | undefined): string {
  if (item === undefined) return '⏎ change seat';
  switch (item.kind) {
    case 'preset':
      return item.preset.notReady.length > 0 ? 'this crew needs ready tools' : '⏎ use this crew';
    case 'crew':
      return '⏎ change seat';
    case 'continue':
      return '⏎ continue';
    default:
      return assertNever(item);
  }
}

/** Continue sits on the same left column as the preset and seat labels. */
function continueText(isCursor: boolean): string {
  const gutter = listRowLead(isCursor ? 'active' : 'default');
  return `${gutter}Continue`;
}

/** The three effects this screen spends: the check it submits, the record it reads back, and
 * the detection retry its cold-discovery panel offers. */
export interface SetupScreenDeps {
  prepareExecution: typeof prepareExecution;
  readRunRecord: typeof readRunRecord;
  refreshPickerDetection: typeof refreshPickerDetection;
}

interface SetupScreenProps {
  prepare?: typeof prepareExecution | undefined;
  deps?: SetupScreenDeps | undefined;
}

type SetupPreparationInput = Readonly<{
  projectDir: string;
  feature: string;
  plannerContext?: string | undefined;
  attachedInputs?: readonly AttachedInput[] | undefined;
  allowRepoRunners: boolean;
}>;

type DiscoveryPanelProps = Readonly<{
  state: 'initializing' | 'failed';
  noConfig: boolean;
  onBack: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}>;

function DiscoveryPanel({ state, noConfig, onBack, onRetry, onOpenSettings }: DiscoveryPanelProps) {
  const t = useTheme();
  const hasOverlay = overlayStore.use((snapshot) => snapshot.active !== 'none');
  const { frame } = useSpinnerFrame(noConfig && state === 'initializing');

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
      <OverlayPanel title={BOOT_MANIFEST_TITLE} density="compact" hint="esc quit">
        {noConfig ? (
          <Text color={t.textDim}>
            <Text color={t.accent}>{frame}</Text> Choose your crew after the tool check.
          </Text>
        ) : (
          <BootManifest />
        )}
      </OverlayPanel>
    );
  }

  return (
    <OverlayPanel
      title="Tool check failed"
      density="compact"
      hint={`r retry${SOFT_SEP}esc quit${SOFT_SEP}s settings`}
    >
      <Text color={t.error}>Your tools could not be checked.</Text>
      <Box marginTop={1}>
        <Text color={t.textDim}>Retry the check or review runner settings.</Text>
      </Box>
    </OverlayPanel>
  );
}

interface CrewStepProps {
  noConfig: boolean;
  note?: string | undefined;
  /** The preparation status while one runs; without one the panel names the focused row's keys. */
  status?: string | undefined;
  /** While the crew is being prepared the list takes no keys, so esc means cancel that attempt. */
  inert?: boolean;
  onContinue: (config: Config) => void;
  onExit: () => void;
}

function CrewStep({ noConfig, note, status, inert = false, onContinue, onExit }: CrewStepProps) {
  const t = useTheme();
  const config = configStore.useConfig();
  const { rows: crewRows, verdict, presets, signedOut } = useCrew();
  const { cols, rows: terminalRows } = terminalSizeStore.use((state) => state);
  const hasOverlay = overlayStore.use((snapshot) => snapshot.active !== 'none');
  const feedback = feedbackStore.use((state) => state);
  const detection = detectionStore.use((state) => state);
  const persisted = configStore.use((state) => state.diskConfig);
  const [availability, setAvailability] = useState<{
    config: Config;
    persisted: Config | null;
    detection: PickerDetectionSnapshot;
    seats: readonly CrewSeat[];
  } | null>(null);
  const checked =
    availability?.config === config &&
    availability.persisted === persisted &&
    availability.detection === detection;
  const unavailableSeats = checked
    ? availability.seats
    : unavailableCrewSeats({ config, detection: withCliCatalogs(detection) });
  const canContinue = checked && unavailableSeats.length === 0;

  useEffect(() => {
    const controller = new AbortController();
    void unavailableSetupSeats(config, detection, controller.signal).then(
      (seats) => {
        if (!controller.signal.aborted) setAvailability({ config, persisted, detection, seats });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted && !isAbortError(cause))
          feedbackStore.setError(toErrorMessage(cause));
      },
    );
    return () => controller.abort();
  }, [config, persisted, detection]);

  const { innerWidth, innerRows } = overlayRect({
    cols,
    rows: terminalRows,
    density: CREW_PANEL_DENSITY,
  });
  const notice = layoutFeedbackNotice(feedback, innerWidth);
  // One sentence names the signed-out tools and their step, so the ready-made crews keep their rows.
  const signIn =
    signedOut.length === 0
      ? undefined
      : wrapPathAware(cliSignInStep(signedOut.join(', '), 'init'), innerWidth);
  const signInRows = signIn === undefined ? 0 : signIn.split('\n').length;
  const budget =
    innerRows -
    PANEL_CHROME_ROWS -
    (noConfig ? NOTE_BLOCK_ROWS : 0) -
    (note === undefined ? 0 : NOTE_BLOCK_ROWS) -
    signInRows -
    (notice?.rows ?? 0);
  const { layout, showPresets, showHeaders, showGaps } = planSetupList({
    crewRows,
    verdict,
    presets,
    signIn: signIn !== undefined,
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

  const list = useFilterableList<SetupItem>({
    items,
    getKey: (item) => item.key,
    filterFn: () => true,
    shouldAppendChar: () => false,
    customKeys: (_input, key) => key.backspace || key.delete,
    initialKey: 'seat:plan',
    isActive: !hasOverlay && !inert,
    pageSize: budget,
    onClose: onExit,
    onSelect: (item) => {
      if (item.kind === 'continue') {
        onContinue(config);
        return;
      }
      if (item.kind === 'preset' && item.preset.notReady.length > 0) return;
      crewActivate({ target: item, config });
    },
  });
  const focusedItem = list.filtered[list.selectedIndex];
  const keys =
    focusedItem?.kind === 'continue' && !canContinue
      ? 'change unavailable seats'
      : crewKeysHint(focusedItem);
  const hint = status ?? `↑↓ select${SOFT_SEP}${keys}${SOFT_SEP}esc quit`;

  return (
    <OverlayPanel title="Set up your crew" density={CREW_PANEL_DENSITY} hint={hint}>
      {noConfig && (
        <Box marginBottom={1}>
          <Text color={t.textDim}>No config. Setup saves .splitbrief/config.yaml.</Text>
        </Box>
      )}
      {note !== undefined && (
        <Box marginBottom={1}>
          <Text color={t.textDim} wrap="truncate-end">
            {note}
          </Text>
        </Box>
      )}
      {signIn !== undefined && (
        <Box marginBottom={showGaps ? 1 : 0}>
          <Text color={t.warning}>{signIn}</Text>
        </Box>
      )}
      <ListViewport
        barColumn="padding"
        width={innerWidth}
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
          hasAfter: (item, index) =>
            layout.verdict && item.kind === 'crew' && list.filtered[index + 1]?.kind !== 'crew',
          renderAfter: (_item, ctx) =>
            verdict === undefined ? null : (
              <CrewVerdictLine verdict={verdict} width={ctx.contentWidth} />
            ),
        }}
        renderItem={(item, ctx) => {
          switch (item.kind) {
            case 'preset':
              return (
                <PresetRowView
                  preset={item.preset}
                  isCursor={ctx.isCursor}
                  width={ctx.contentWidth}
                  labelWidth={presetLabelWidth}
                />
              );
            case 'crew': {
              const unavailable = unavailableSeats.some((seat) => seat.id === item.row.id);
              const availabilityWidth = unavailable ? getTerminalCellWidth('  Unavailable') : 0;
              return (
                <Box>
                  <CrewRowView
                    row={item.row}
                    layout={
                      unavailable
                        ? {
                            ...layout,
                            identityWidth:
                              ctx.contentWidth - availabilityWidth - CREW_IDENTITY_COLUMN,
                            posture: false,
                          }
                        : layout
                    }
                    isCursor={ctx.isCursor}
                    width={ctx.contentWidth - availabilityWidth}
                  />
                  {unavailable && <Text color={t.warning}>{'  Unavailable'}</Text>}
                </Box>
              );
            }
            case 'continue':
              return (
                <Text
                  color={ctx.isCursor && canContinue ? t.accent : t.textDim}
                  bold={ctx.isCursor && canContinue}
                >
                  {continueText(ctx.isCursor)}
                  {!canContinue && `${SOFT_SEP}choose ready seats`}
                </Text>
              );
            default:
              return assertNever(item);
          }
        }}
      />
      {notice !== null && <FeedbackNotice notice={notice} width={innerWidth} />}
    </OverlayPanel>
  );
}

export function SetupScreen({ prepare, deps }: SetupScreenProps) {
  // A supplied deps is the source of all three; without one the screen keeps the production
  // functions, and `prepare` alone stays the narrower seam the existing tests pass.
  const effects: SetupScreenDeps = deps ?? {
    prepareExecution: prepare ?? prepareExecution,
    readRunRecord,
    refreshPickerDetection,
  };
  const { exit } = useApp();
  const projectDir = configStore.use((state) => state.projectDir);
  const noConfig = configStore.use((state) => state.revision === null);
  const initialCrewSelected = useRef(false);
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
  const pendingAttachedInputs = routerStore.use((state) =>
    state.screen === 'setup' ? state.attachedInputs : undefined,
  );
  const pendingAllowRepoRunners = routerStore.use((state) =>
    state.screen === 'setup' ? state.allowRepoRunners : undefined,
  );
  const approvalPending = approvalPromptStore.use((state) => state.status === 'pending');
  const hasOverlay = overlayStore.use((state) => state.active !== 'none');
  // Moving into work is the same wait as anywhere else: the crew panel stays where it is and its
  // fixed hint row states the check, rather than a second fullscreen loader taking the screen.
  const checkingStage = preparationStore.use((state) =>
    state.kind === 'checking' ? state.stage : null,
  );
  const { frame: preparationFrame } = useSpinnerFrame(checkingStage !== null);
  const [step, setStep] = useState<Step>('discovery');
  const saveCheck = useRef<AbortController | null>(null);

  const preparation = useStartPreparation<SetupPreparationInput>({
    prepare: async (input, signal) => {
      const currentConfig = configStore.get().config;
      if (currentConfig === null) {
        return { kind: 'failed', error: appPreparationError.configNotLoaded() };
      }
      return effects.prepareExecution({
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
        ...(input.attachedInputs !== undefined && { attachedInputs: input.attachedInputs }),
      });
    },
    onPrepared: (execution) => {
      routerStore.navigate({
        to: 'workflow',
        run: effects.readRunRecord(execution.session.ref),
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
  const effectiveStep = step === 'discovery' && hasRememberedDiscovery && !noConfig ? 'crew' : step;

  useEffect(() => {
    if (
      !noConfig ||
      initialCrewSelected.current ||
      readiness.outcome !== 'fresh' ||
      readiness.refreshing
    )
      return;
    const crew = selectDetectedDefaultCrew(detectionStore.get());
    if (crew !== null) {
      initialCrewSelected.current = true;
      configStore.setInitialCrew(crew);
    }
  }, [noConfig, readiness.outcome, readiness.generation, readiness.refreshing]);

  useEffect(() => {
    if (step === 'discovery' && readiness.outcome === 'fresh' && !readiness.refreshing) {
      setStep('crew');
    }
  }, [readiness.outcome, readiness.refreshing, step]);

  useEffect(
    () => () => {
      saveCheck.current?.abort();
      if (sessionSelectStore.get().preparation.kind === 'idle') closeApprovalPrompt();
    },
    [],
  );

  const retryDiscovery = () => {
    if (!projectDir) return;
    void effects.refreshPickerDetection(projectDir);
  };

  const cancelPreparation = () => {
    preparation.cancel(() => {
      closeApprovalPrompt();
      setStep('crew');
    });
  };

  const preparing = preparation.state.kind === 'preparing';
  const preparationTakesPage =
    preparation.state.kind === 'blocked' ||
    preparation.state.kind === 'failed' ||
    (preparing && approvalPending);

  // Escape gives up this attempt and leaves the crew exactly as it was chosen.
  useInput(
    (_input, key) => {
      if (key.escape) cancelPreparation();
    },
    { isActive: preparing && !preparationTakesPage && !hasOverlay },
  );

  const finalize = async (finalConfig: Config) => {
    if (!projectDir) return;
    saveCheck.current?.abort();
    const controller = new AbortController();
    saveCheck.current = controller;
    const detection = detectionStore.get();
    const persisted = configStore.get().diskConfig;
    const unavailable = await unavailableSetupSeats(finalConfig, detection, controller.signal);
    if (
      controller.signal.aborted ||
      configStore.get().config !== finalConfig ||
      configStore.get().diskConfig !== persisted ||
      detectionStore.get() !== detection
    )
      return;
    if (unavailable.length > 0) {
      feedbackStore.setError('Choose a ready tool and model for each unavailable seat.');
      return;
    }
    const result = await configStore.save(finalConfig);
    if (reportConfigSaveFailure(result)) return;

    if (onComplete === 'workflow' && pendingFeature) {
      feedbackStore.setMessage(formatConfigSaveSuccess('your crew', result));
      observePreparationCleanup(
        preparation.submit({
          projectDir,
          feature: pendingFeature,
          ...(pendingPlannerContext !== undefined && { plannerContext: pendingPlannerContext }),
          ...(pendingAttachedInputs !== undefined && { attachedInputs: pendingAttachedInputs }),
          allowRepoRunners: pendingAllowRepoRunners ?? false,
        }),
      );
      return;
    }

    routerStore.navigate({ to: 'home' });
    feedbackStore.setMessage(formatConfigSaveSuccess('your crew', result));
  };

  if (preparationTakesPage) {
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
    const coldFailed =
      !readiness.refreshing &&
      (readiness.outcome === 'failed' ||
        (readiness.outcome === 'stale' && readiness.error !== null));
    return (
      <DiscoveryPanel
        state={coldFailed ? 'failed' : 'initializing'}
        noConfig={noConfig}
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

  const preparationStatus =
    checkingStage === null
      ? undefined
      : `${preparationFrame} ${checkingStage}${preparing ? `${SOFT_SEP}esc cancel` : ''}`;

  return (
    <CrewStep
      noConfig={noConfig}
      note={rememberedStepLabel}
      status={preparationStatus}
      inert={checkingStage !== null}
      onContinue={(current) => void finalize(current)}
      onExit={() => {
        saveCheck.current?.abort();
        exit();
      }}
    />
  );
}
