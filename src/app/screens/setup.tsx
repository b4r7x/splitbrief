import { useEffect, useRef, useState } from 'react';
import { useApp } from 'ink';
import { SOFT_SEP } from '../../core/separators.js';
import { selectDefaultCrew } from '../../core/crew/default.js';
import { overlayRect } from '../../core/navigation/overlay-rect.js';
import { REFRESHING_TOOLS_TITLE } from '../../core/discovery/copy.js';
import { prepareExecution } from '../../engine/runners/prepare-execution/prepare.js';
import { CREW_PANEL_DENSITY, CrewStep } from '../../features/crew/setup/crew-step.js';
import { useFinalize } from '../../features/crew/setup/use-finalize.js';
import { useSpinnerFrame } from '../../hooks/use-spinner-frame.js';
import { useSlowProbeText } from '../../hooks/use-slow-probe-text.js';
import { refreshPickerDetection } from '../../features/runners/refresh-detection.js';
import { observePreparationCleanup } from '../../features/start-preparation/observe-cleanup.js';
import { useStartPreparation } from '../../features/start-preparation/use-start-preparation.js';
import { useCancelKey } from '../../features/start-preparation/use-cancel-key.js';
import { useClosePromptOnLeave } from '../../features/start-preparation/use-close-prompt-on-leave.js';
import { approvalPromptStore, closeApprovalPrompt } from '../../stores/prompts/approval.js';
import { routerStore } from '../../stores/navigation/router.js';
import { preparationStore, selectCheckingStage } from '../../stores/navigation/preparation.js';
import { readRunRecord } from '../../core/sessions/run/record-io.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/discovery/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { checkingStatusText, prepareStart, type StartRequest } from '../prepare-start.js';
import { PreparationGate } from '../preparation-gate.js';
import { ColdDiscoveryPanel } from '../../features/runners/cold-discovery-panel.js';

type Step = 'discovery' | 'crew';

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

/**
 * The step that the page shows. A fresh discovery opens the crew step, and with no config it
 * selects the default crew first.
 */
function useSetupStep(noConfig: boolean) {
  const initialCrewSelected = useRef(false);
  const refresh = detectionStore.use((state) => state.refresh);
  const readiness = refresh.readiness;
  const [step, setStep] = useState<Step>('discovery');

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
    const crew = selectDefaultCrew(detectionStore.get());
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

  const coldFailed =
    !readiness.refreshing &&
    (readiness.outcome === 'failed' || (readiness.outcome === 'stale' && readiness.error !== null));

  let rememberedStepLabel: string | undefined;
  if (hasRememberedDiscovery && discoveryRefreshing) {
    rememberedStepLabel = `${REFRESHING_TOOLS_TITLE}${SOFT_SEP}remembered results`;
  } else if (warmRefreshFailed) {
    rememberedStepLabel = `Refresh failed${SOFT_SEP}remembered results`;
  }

  return { effectiveStep, showCrew: () => setStep('crew'), coldFailed, rememberedStepLabel };
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
  const { cols, rows } = terminalSizeStore.use((state) => state);
  const projectDir = configStore.use((state) => state.projectDir);
  const noConfig = configStore.use((state) => state.revision === null);
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
  // Moving into work is the same wait as anywhere else: the crew panel stays where it is and its
  // fixed hint row states the check, rather than a second fullscreen loader taking the screen.
  const checkingStage = preparationStore.use(selectCheckingStage);
  const { frame: preparationFrame } = useSpinnerFrame(checkingStage !== null);
  const slowProbe = useSlowProbeText();

  const preparation = useStartPreparation<StartRequest>({
    prepare: (request, signal) => prepareStart(effects.prepareExecution, request, signal),
    onPrepared: (execution) => {
      routerStore.navigate({
        to: 'workflow',
        run: effects.readRunRecord(execution.session.ref, configStore.reviewNone()),
        execution: { kind: 'local', prepared: execution },
      });
    },
  });

  const { effectiveStep, showCrew, coldFailed, rememberedStepLabel } = useSetupStep(noConfig);

  const crewSave = useFinalize(
    onComplete === 'workflow' && pendingFeature
      ? () =>
          observePreparationCleanup(
            preparation.submit({
              feature: pendingFeature,
              ...(pendingPlannerContext !== undefined && { plannerContext: pendingPlannerContext }),
              ...(pendingAttachedInputs !== undefined && { attachedInputs: pendingAttachedInputs }),
              allowRepoRunners: pendingAllowRepoRunners ?? false,
            }),
          )
      : undefined,
  );
  useClosePromptOnLeave();

  const retryDiscovery = () => {
    if (!projectDir) return;
    void effects.refreshPickerDetection(projectDir);
  };

  const cancelPreparation = () => {
    preparation.cancel(() => {
      closeApprovalPrompt();
      showCrew();
    });
  };

  const preparing = preparation.state.kind === 'preparing';
  const preparationTakesPage =
    preparation.state.kind === 'blocked' ||
    preparation.state.kind === 'failed' ||
    (preparing && approvalPending);

  // Escape gives up this attempt and leaves the crew exactly as it was chosen.
  useCancelKey({ preparing, takesPage: preparationTakesPage, onCancel: cancelPreparation });

  if (preparationTakesPage) {
    return (
      <PreparationGate
        state={preparation.state}
        retry={preparation.retry}
        onBack={cancelPreparation}
      />
    );
  }

  if (effectiveStep === 'discovery') {
    return (
      <ColdDiscoveryPanel
        state={coldFailed ? 'failed' : 'initializing'}
        noConfig={noConfig}
        onBack={exit}
        onRetry={retryDiscovery}
        onOpenSettings={() => overlayStore.open('settings')}
      />
    );
  }

  const preparationStatus = checkingStatusText({
    frame: preparationFrame,
    stage: checkingStage,
    slowProbe,
    cancellable: preparing,
    width: overlayRect({ cols, rows, density: CREW_PANEL_DENSITY }).innerWidth,
  });

  return (
    <CrewStep
      noConfig={noConfig}
      note={rememberedStepLabel}
      status={preparationStatus}
      inert={checkingStage !== null}
      onContinue={(current) => void crewSave.finalize(current)}
      onExit={() => {
        crewSave.abort();
        exit();
      }}
    />
  );
}
