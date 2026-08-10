import { Fragment, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { INITIALIZING_TOOLS_TITLE, REFRESHING_TOOLS_TITLE } from '../../core/discovery/copy.js';
import { getProviderDisplayName } from '../../core/providers/catalog.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { prepareExecution } from '../../engine/runners/prepare-execution.js';
import { useTheme } from '../../components/theme.js';
import { Composer } from '../../components/composer/composer.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { SOFT_SEP } from '../../components/separators.js';
import { HomeConfigSummary } from '../../features/home/components/config-summary.js';
import { RecentSessions } from '../../features/home/components/recent-sessions.js';
import { useSpinnerFrame } from '../../features/workflow/hooks/use-spinner-frame.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { detectionStore } from '../../stores/project/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-stores.js';
import type { Session } from '../../core/schemas/session.js';
import {
  handleSessionSelect,
  type SessionSelectDeps,
  sessionSelectStore,
} from '../../stores/navigation/session-select.js';
import { getHomeLayout } from '../../features/home/layout.js';
import { getLogo } from '../../features/home/logo.js';
import { RECENT_SESSIONS_HINT } from '../../features/home/components/recent-sessions-list.js';
import { useRecentSessionsFocus } from '../../features/home/use-recent-sessions-focus.js';
import { interactivePreparationPolicy, sessionSelectDeps } from '../prepare-resume.js';
import { useStartPreparation } from '../../features/start-preparation/use-start-preparation.js';
import { StartPreparationPanel } from '../../features/start-preparation/panel.js';
import { observePreparationCleanup } from '../../features/start-preparation/observe-cleanup.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import { approvalPromptStore, closeApprovalPrompt } from '../../stores/approval-prompt/prompt.js';

const DEFAULT_HOME_HINT = `/help${SOFT_SEP}/settings${SOFT_SEP}/skills${SOFT_SEP}ctrl+k commands`;
const HOME_HINT = `/help${SOFT_SEP}/settings${SOFT_SEP}/skills${SOFT_SEP}ctrl+r recent${SOFT_SEP}ctrl+k commands`;
const HOME_SELECTION_ERROR_CLEAR_MS = 3000;

export interface HomeScreenDeps {
  prepareExecution: typeof prepareExecution;
  sessionSelect: SessionSelectDeps;
}

interface HomeScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
  deps?: HomeScreenDeps | undefined;
}

const defaultHomeScreenDeps: HomeScreenDeps = {
  prepareExecution,
  sessionSelect: sessionSelectDeps,
};

/** Below this height the box would crowd out sessions; the hint line takes over. */
const DISCOVERY_PANEL_MIN_ROWS = 24;
/** Panel height plus one breathing row — the slack the box needs to render whole. */
const DISCOVERY_PANEL_SLACK_ROWS = 5;

/**
 * Cold-discovery box floating in the slack space between the content block and
 * the bottom-anchored composer. It exists only while the first check runs (or
 * has stalled), then vanishes without leaving a residue — the slack absorbs
 * both states, so nothing above or below ever moves.
 */
function DiscoveryPanel() {
  const theme = useTheme();
  const config = configStore.useConfig();
  const refresh = detectionStore.use((s) => s.refresh);
  const cold = refresh.readiness.fetchedAt === null;
  const refreshing =
    refresh.readiness.refreshing || refresh.modelsDev.refreshing || refresh.cliModels.refreshing;
  const { frame } = useSpinnerFrame(cold && refreshing);

  if (!cold) return null;

  // A settled cold check without a result: failed outright, or not-run
  // (offline/cancelled). Both need an actionable box, never a frozen spinner.
  const stalled =
    !refreshing &&
    (refresh.readiness.outcome === 'failed' || refresh.readiness.outcome === 'not-run');
  if (!refreshing && !stalled) return null;
  const failedOutcome = refresh.readiness.outcome === 'failed';
  const plannerName = getProviderDisplayName(getRunnerDisplayName(config.planner));
  const implementerName = getProviderDisplayName(getRunnerDisplayName(config.implementer));

  return (
    <Box
      borderStyle="round"
      borderColor={stalled ? (failedOutcome ? theme.error : theme.warning) : theme.accent}
      paddingX={2}
      flexDirection="column"
    >
      {stalled ? (
        <Fragment>
          <Text color={failedOutcome ? theme.error : theme.warning} bold>
            {failedOutcome ? 'Tool check failed' : 'Tools not checked'}
          </Text>
          <Text color={theme.textDim}>Open /settings to retry.</Text>
        </Fragment>
      ) : (
        <Fragment>
          <Text>
            <Text color={theme.accent} bold>
              {frame} {INITIALIZING_TOOLS_TITLE}
            </Text>
          </Text>
          <Text>
            <Text color={theme.planner}>{plannerName}</Text>
            <Text color={theme.textDim}>{SOFT_SEP}</Text>
            <Text color={theme.implementer}>{implementerName}</Text>
            <Text color={theme.textDim}>{SOFT_SEP}first run, results are remembered</Text>
          </Text>
        </Fragment>
      )}
    </Box>
  );
}

export function HomeScreen({
  commands,
  onRuntimeCommand,
  deps = defaultHomeScreenDeps,
}: HomeScreenProps) {
  const theme = useTheme();
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const [{ cols, rows, isSmall }, { sessions, totalCount }, { projectDir }] = useStores(
    terminalSizeStore,
    sessionsStore,
    configStore,
  );
  const selectionError = sessionSelectStore.use((s) => s.error);
  const approvalPending = approvalPromptStore.use((state) => state.status === 'pending');
  const discoveryNotice = detectionStore.use((s) => {
    const r = s.refresh;
    if (!(r.readiness.refreshing || r.modelsDev.refreshing || r.cliModels.refreshing)) return null;
    return r.readiness.fetchedAt === null ? 'cold' : 'warm';
  });
  const startPreparation = useStartPreparation<string>({
    prepare: async (feature, signal) => {
      const current = configStore.get();
      if (!current.config || !current.projectDir) {
        return { kind: 'failed', error: new Error('Project configuration is not loaded.') };
      }
      return deps.prepareExecution({
        projectDir: current.projectDir,
        feature,
        effectiveConfig: current.config,
        policy: {
          ...interactivePreparationPolicy,
          purpose: 'new-workflow',
          allowRepoRunners: false,
        },
        signal,
      });
    },
    onPrepared: (execution) => {
      routerStore.navigate({
        to: 'workflow',
        execution: { kind: 'local', prepared: execution },
      });
    },
  });
  const [sessionsFocused, setSessionsFocused] = useState(false);
  const preparationState = startPreparation.state;
  const isPreparing = preparationState.kind === 'preparing';
  const showPreparationPanel =
    approvalPending || preparationState.kind === 'blocked' || preparationState.kind === 'failed';
  const preliminaryLayout = getHomeLayout({
    cols,
    rows,
    isSmall,
    sessionCount: totalCount,
    sessionsFocused: false,
  });
  const focusedLayout = getHomeLayout({
    cols,
    rows,
    isSmall,
    sessionCount: totalCount,
    sessionsFocused: true,
  });
  const hasRoomForSessions = preliminaryLayout.recentSessionLimit > 0;
  const canFocus = focusedLayout.recentSessionLimit > 0 && sessions.length > 0;
  const sessionsActive = sessionsFocused && canFocus;
  const layout = sessionsActive ? focusedLayout : preliminaryLayout;
  const interactionBlocked = hasOverlay || showPreparationPanel;

  // The box needs real slack below the rendered session rows, or it would be
  // clipped to a partial slice; without slack the hint line carries the notice.
  const renderedSessionRows = hasRoomForSessions
    ? Math.min(sessions.length, layout.recentSessionLimit) + (layout.showHiddenCount ? 1 : 0)
    : 0;
  const discoveryPanelFits =
    rows >= DISCOVERY_PANEL_MIN_ROWS &&
    layout.sessionCapacity - renderedSessionRows >= DISCOVERY_PANEL_SLACK_ROWS;
  const hintNotice =
    discoveryNotice === 'warm' || (discoveryNotice === 'cold' && !discoveryPanelFits);
  const { frame: refreshFrame } = useSpinnerFrame(hintNotice);
  const { frame: preparationFrame } = useSpinnerFrame(isPreparing);

  useEffect(() => {
    if (!canFocus) setSessionsFocused(false);
  }, [canFocus]);

  useEffect(() => {
    if (!sessionsActive || !selectionError) return undefined;
    const timer = setTimeout(() => sessionSelectStore.clearError(), HOME_SELECTION_ERROR_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [sessionsActive, selectionError]);

  useEffect(
    () => () => {
      if (sessionSelectStore.get().preparation.kind === 'idle') closeApprovalPrompt();
    },
    [],
  );

  const closeRecentSessions = () => {
    setSessionsFocused(false);
    sessionSelectStore.clearError();
  };

  useRecentSessionsFocus({
    hasSessions: canFocus,
    hasOverlay: interactionBlocked || isPreparing,
    focused: sessionsActive,
    onEnter: () => setSessionsFocused(true),
  });
  const onStartWorkflow = (feature: string) => {
    observePreparationCleanup(startPreparation.submit(feature));
  };

  useInput(
    (_input, key) => {
      if (key.escape) startPreparation.cancel(closeApprovalPrompt);
    },
    { isActive: isPreparing && !hasOverlay },
  );

  let homeHint: string | undefined;
  if (!interactionBlocked) {
    homeHint = DEFAULT_HOME_HINT;
    if (canFocus) homeHint = HOME_HINT;
    // The notice borrows the reserved hint line instead of adding a row, so it
    // never moves the layout.
    if (hintNotice) {
      homeHint = `${refreshFrame} ${
        discoveryNotice === 'cold' ? INITIALIZING_TOOLS_TITLE : REFRESHING_TOOLS_TITLE
      }`;
    }
    if (sessionsActive) homeHint = RECENT_SESSIONS_HINT;
  }

  if (showPreparationPanel) {
    return (
      <StartPreparationPanel
        state={startPreparation.state}
        onRetry={() => observePreparationCleanup(startPreparation.retry())}
        onBack={() => startPreparation.cancel(closeApprovalPrompt)}
        onOpenSettings={() => overlayStore.open('settings')}
        approvalPrompt={approvalPending ? <ApprovalPrompt /> : undefined}
      />
    );
  }

  return (
    <ScreenShell justifyContent="flex-start" alignItems="center">
      <Box flexDirection="column" width={layout.inputWidth} height="100%">
        <Box flexDirection="column" flexGrow={1} overflowY="hidden" alignItems="center">
          <Box flexDirection="column" width={layout.bodyWidth} gap={1} flexShrink={0}>
            <Box flexDirection="column" alignItems="center" flexShrink={0}>
              <Text color={theme.accent}>{getLogo(layout.logoTier)}</Text>
            </Box>

            <HomeConfigSummary />

            {hasRoomForSessions && (
              <RecentSessions
                limit={layout.recentSessionLimit}
                showHiddenCount={layout.showHiddenCount}
                focused={sessionsActive}
                onSelect={(session: Session) =>
                  handleSessionSelect(session, projectDir, deps.sessionSelect)
                }
                onClose={closeRecentSessions}
                hasOverlay={interactionBlocked}
              />
            )}
            {sessionsActive && (
              <Box height={1} overflow="hidden">
                {selectionError && (
                  <Text color={theme.error} wrap="truncate-end">
                    {selectionError}
                  </Text>
                )}
              </Box>
            )}
          </Box>
          <Box
            flexGrow={1}
            flexDirection="column"
            justifyContent="center"
            alignItems="center"
            overflow="hidden"
          >
            {discoveryPanelFits && <DiscoveryPanel />}
          </Box>
        </Box>

        <Box flexDirection="column" marginBottom={layout.inputBottomMargin} flexShrink={0}>
          <Composer
            disabled={interactionBlocked || sessionsActive || isPreparing}
            submitKeepsDraft
            promptGlyph={isPreparing ? preparationFrame : undefined}
            onSubmit={onStartWorkflow}
            onRuntimeCommand={onRuntimeCommand}
            commands={commands}
            mode="normal"
            hint="Describe your feature…"
            currentScreen="home"
            width={layout.inputWidth}
            homeHint={homeHint}
            draftRestore={startPreparation.draftRestore}
          />
        </Box>
      </Box>
    </ScreenShell>
  );
}
