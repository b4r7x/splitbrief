import { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  computeOverlayInnerRowCapacity,
  computeOverlayInnerWidth,
  OverlayPanel,
} from '../../components/overlays/overlay-panel.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { glyph } from '../../lib/glyphs.js';
import type { Config } from '../../core/schemas/config.js';
import {
  INITIALIZING_TOOLS_BODY,
  INITIALIZING_TOOLS_TITLE,
  REFRESHING_TOOLS_TITLE,
} from '../../core/discovery/copy.js';
import { prepareExecution } from '../../engine/runners/prepare-execution.js';
import { CREW_PANEL_CHROME_ROWS } from '../../features/crew/format.js';
import {
  crewActivate,
  crewFocusIndex,
  crewFocusMove,
  crewFocusRows,
} from '../../features/crew/rows.js';
import { PresetRow } from '../../features/crew/preset-row.js';
import { SeatRows, crewSeatBlockRows } from '../../features/crew/seat-rows.js';
import { useCrew } from '../../features/crew/use-crew.js';
import { refreshPickerDetection } from '../../features/runners/picker-view.js';
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
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { getClampedTerminalWidth } from '../../utils/terminal-width.js';
import { interactivePreparationPolicy } from '../prepare-resume.js';

type Step = 'discovery' | 'crew';

const SETUP_PANEL_WIDTH = 72;
/** The blank line under the preset block. */
const PRESET_BLOCK_EXTRA_ROWS = 1;
/** The note line and the blank line under it. */
const NOTE_ROWS = 2;

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
      <OverlayPanel title={INITIALIZING_TOOLS_TITLE} maxWidth={72} hint="esc back">
        <Text color={t.textDim}>{INITIALIZING_TOOLS_BODY}</Text>
      </OverlayPanel>
    );
  }

  return (
    <OverlayPanel
      title="Tool check failed"
      maxWidth={72}
      hint={`r retry${SOFT_SEP}esc back${SOFT_SEP}s settings`}
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
  const { seats, presets } = useCrew();
  const { cols, rows: terminalRows } = terminalSizeStore.use((state) => state);
  const hasOverlay = overlayStore.use((snapshot) => snapshot.active !== 'none');
  const error = feedbackStore.use((state) => (state.isError ? state.message : null));
  // Local, not overlayStore.focus: this is a screen, not an overlay, so it has no stack entry to
  // restore from and its focused row must not leak into the next overlay that opens.
  const [focus, setFocus] = useState<string | undefined>(undefined);

  const capacity = computeOverlayInnerRowCapacity({
    terminalRows,
    outerChromeRows: CREW_PANEL_CHROME_ROWS,
  });
  // The seats, the Continue row and the error hold their rows at every supported viewport; the
  // blank separators, the note and the preset block yield in that order until the panel fits.
  const errorRows = error === null ? 0 : 1;
  let usedRows = crewSeatBlockRows(seats) + 1 + errorRows;
  const showsContinueGap = usedRows + 1 <= capacity;
  if (showsContinueGap) usedRows += 1;
  const showsErrorGap = errorRows > 0 && usedRows + 1 <= capacity;
  if (showsErrorGap) usedRows += 1;
  const showsNote = note !== undefined && usedRows + NOTE_ROWS <= capacity;
  if (showsNote) usedRows += NOTE_ROWS;
  const showsPresets =
    presets.length > 0 && usedRows + presets.length + PRESET_BLOCK_EXTRA_ROWS <= capacity;

  const rows = crewFocusRows({ presets: showsPresets ? presets : [], seats, continueRow: true });
  const index = crewFocusIndex({ rows, key: focus });
  const active = rows[index];

  const move = (delta: number) => {
    setFocus(crewFocusMove({ rows, index, delta }));
  };

  const activate = () => {
    if (active?.kind === 'continue') {
      onContinue(config);
      return;
    }
    crewActivate({ row: active, presets, config });
  };

  useInput(
    (_input, key) => {
      if (key.escape) {
        onExit();
        return;
      }
      if (key.upArrow) {
        move(-1);
        return;
      }
      if (key.downArrow) {
        move(1);
        return;
      }
      if (key.return) activate();
    },
    { isActive: !hasOverlay },
  );

  const continueFocused = active?.kind === 'continue';
  const crewWidth = computeOverlayInnerWidth(
    getClampedTerminalWidth({ cols, maxWidth: SETUP_PANEL_WIDTH }),
  );

  return (
    <OverlayPanel
      title="Set up your crew"
      maxWidth={SETUP_PANEL_WIDTH}
      hint={`↑↓ navigate${SOFT_SEP}⏎ select${SOFT_SEP}esc back`}
    >
      {showsNote && (
        <Box marginBottom={1}>
          <Text color={t.textDim}>{note}</Text>
        </Box>
      )}
      {showsPresets && (
        <Box marginBottom={1}>
          <PresetRow
            presets={presets}
            selected={active?.kind === 'preset' ? active.id : undefined}
            width={crewWidth}
          />
        </Box>
      )}
      <SeatRows
        seats={seats}
        selected={active?.kind === 'seat' ? active.id : undefined}
        width={crewWidth}
      />
      <Box marginTop={showsContinueGap ? 1 : 0}>
        <Text color={continueFocused ? t.accent : t.textDim} bold={continueFocused}>
          {`${continueFocused ? `${glyph('promptMarker')} ` : '  '}Continue`}
        </Text>
      </Box>
      {error !== null && (
        <Box marginTop={showsErrorGap ? 1 : 0}>
          <Text color={t.error} wrap="truncate-end">
            {sanitizeTerminalDisplayText(error)}
          </Text>
        </Box>
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
        return { kind: 'failed', error: new Error('Project configuration is not loaded.') };
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
