import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import type { Config } from '../../core/schemas/config.js';
import {
  INITIALIZING_TOOLS_BODY,
  INITIALIZING_TOOLS_TITLE,
  REFRESHING_TOOLS_TITLE,
} from '../../core/discovery/copy.js';
import { prepareExecution } from '../../engine/runners/prepare-execution.js';
import { refreshPickerDetection } from '../../features/runners/picker-view.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import { StartPreparationPanel } from '../../features/start-preparation/panel.js';
import { observePreparationCleanup } from '../../features/start-preparation/observe-cleanup.js';
import { useStartPreparation } from '../../features/start-preparation/use-start-preparation.js';
import { approvalPromptStore, closeApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionSelectStore } from '../../stores/navigation/session-select.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { interactivePreparationPolicy } from '../prepare-resume.js';

type Step = 'discovery' | 'planner' | 'implementer';

export interface SetupToolPickerArgs {
  role: 'planner' | 'implementer';
  stepLabel: string;
  onConfirm: (updated: Config) => Promise<void>;
  onCancel: () => void;
}

interface SetupScreenProps {
  renderToolPicker: (args: SetupToolPickerArgs) => ReactNode;
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

export function SetupScreen({ renderToolPicker, prepare = prepareExecution }: SetupScreenProps) {
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
  const effectiveStep = step === 'discovery' && hasRememberedDiscovery ? 'planner' : step;

  useEffect(() => {
    if (step === 'discovery' && readiness.outcome === 'fresh' && !readiness.refreshing) {
      setStep('planner');
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
      setStep('implementer');
    });
  };

  const saveFailure = (result: Awaited<ReturnType<typeof configStore.save>>): boolean => {
    if (result.kind === 'saved') return false;
    if (result.kind === 'failure') {
      feedbackStore.setError(`Failed to save config: ${result.error.message}`);
    } else if (result.kind === 'durability-uncertain') {
      feedbackStore.setError(`Config save could not be confirmed: ${result.warning}`);
    } else {
      feedbackStore.setError('Config changed on disk. Reload before saving again.');
    }
    return true;
  };

  const finalize = async (finalConfig: Config) => {
    if (!projectDir) return;
    const result = await configStore.save(finalConfig);
    if (saveFailure(result)) return;

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

  if (effectiveStep === 'planner') {
    return (
      <Fragment key="planner">
        {renderToolPicker({
          role: 'planner',
          stepLabel: rememberedStepLabel ?? `Choose planner${SOFT_SEP}1 of 2`,
          onConfirm: async (updated) => {
            const result = await configStore.save(updated);
            if (!saveFailure(result)) setStep('implementer');
          },
          onCancel: exit,
        })}
      </Fragment>
    );
  }

  return (
    <Fragment key="implementer">
      {renderToolPicker({
        role: 'implementer',
        stepLabel: rememberedStepLabel ?? `Choose model${SOFT_SEP}2 of 2`,
        onConfirm: finalize,
        onCancel: () => setStep('planner'),
      })}
    </Fragment>
  );
}
