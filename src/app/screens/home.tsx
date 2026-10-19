import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { TextSpans } from '../../components/text-spans.js';
import { Fragment, useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import {
  BOOT_MANIFEST_TITLE,
  FIRST_RUN_NOTE,
  REFRESHING_TOOLS_TITLE,
} from '../../core/discovery/copy.js';
import { formatCollapsedSeatSpans, seatLineText } from '../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { useCrewDisplayNames } from '../../hooks/use-crew-display-names.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { prepareExecution } from '../../engine/runners/prepare-execution/prepare-execution.js';
import { Composer } from '../../components/composer/composer.js';
import type { DraftSubmission } from '../../core/composer/submission.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { SOFT_SEP } from '../../core/separators.js';
import { HomeSeatBlock, shedToFit } from '../../features/home/components/seat-block.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { RecentSessions } from '../../features/home/components/recent-sessions.js';
import { useSpinnerFrame } from '../../hooks/use-spinner-frame.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { detectionStore } from '../../stores/project/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { preparationStore } from '../../stores/navigation/preparation.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-stores.js';
import type { Session } from '../../core/schemas/session.js';
import { readRunRecord } from '../../core/sessions/run-record-io.js';
import {
  handleSessionSelect,
  type SessionSelectDeps,
  sessionSelectStore,
} from '../../stores/navigation/session-select.js';
import { borderStyleFor } from '../../lib/glyphs.js';
import { MARK_SLOT_CELLS } from '../../components/row-leading.js';
import { getHomeLayout, NO_CONFIG_NOTICE } from '../../features/home/layout.js';
import { getLogo } from '../../features/home/logo.js';
import { RECENT_SESSIONS_HINT } from '../../features/home/components/recent-sessions-list.js';
import { useRecentSessionsFocus } from '../../features/home/use-recent-sessions-focus.js';
import {
  appPreparationError,
  interactivePreparationPolicy,
  sessionSelectDeps,
} from '../prepare-resume.js';
import { useStartPreparation } from '../../features/start-preparation/use-start-preparation.js';
import { StartPreparationPanel } from '../../features/start-preparation/panel.js';
import { observePreparationCleanup } from '../../features/start-preparation/observe-cleanup.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import { approvalPromptStore, closeApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import type { readClipboardImage } from '../../core/attachments/clipboard-image.js';
import type { listProjectFiles } from '../../lib/file-listing.js';

const DEFAULT_HOME_HINT = `/help${SOFT_SEP}/crew${SOFT_SEP}/settings${SOFT_SEP}/skills${SOFT_SEP}ctrl+k commands`;
const HOME_HINT = `/help${SOFT_SEP}/crew${SOFT_SEP}/settings${SOFT_SEP}/skills${SOFT_SEP}ctrl+r recent${SOFT_SEP}ctrl+k commands`;
const HOME_SELECTION_ERROR_CLEAR_MS = 3000;

export interface HomeScreenDeps {
  prepareExecution: typeof prepareExecution;
  sessionSelect: SessionSelectDeps;
}

interface HomeScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
  deps?: HomeScreenDeps | undefined;
  readClipboardImage?: typeof readClipboardImage | undefined;
  listProjectFiles?: typeof listProjectFiles | undefined;
}

const defaultHomeScreenDeps: HomeScreenDeps = {
  prepareExecution,
  sessionSelect: sessionSelectDeps,
};

/** Below this height the box would crowd out sessions; the hint line takes over. */
const DISCOVERY_PANEL_MIN_ROWS = 24;
/** Panel height plus one breathing row — the slack the box needs to render whole. */
const DISCOVERY_PANEL_SLACK_ROWS = 5;
/** `paddingX={2}` on both sides plus the round border on both — the cells the text cannot use. */
const DISCOVERY_PANEL_CHROME_COLS = 6;

/**
 * Cold-discovery box floating in the slack space between the content block and
 * the bottom-anchored composer. It exists only while the first check runs (or
 * has stalled), then vanishes without leaving a residue — the slack absorbs
 * both states, so nothing above or below ever moves.
 */
function DiscoveryPanel({ width }: { width: number }) {
  const theme = useTheme();
  const config = configStore.useConfig();
  const displayNames = useCrewDisplayNames(config);
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
  const seatInput = {
    planner: config.planner,
    build: resolveImplementerProfiles(config).defaultProfile.config,
    reviewer: configuredReviewerRunner(config),
    displayNames,
  };
  const budget = width - DISCOVERY_PANEL_CHROME_COLS;
  const fullSeatLine = seatLineText(formatCollapsedSeatSpans(seatInput));
  const notes = shedToFit({
    lead: [fullSeatLine],
    optional: [FIRST_RUN_NOTE],
    width: budget,
  });
  const seatLine = formatCollapsedSeatSpans({
    ...seatInput,
    budget: budget - (notes.length > 0 ? getTerminalCellWidth(`${SOFT_SEP}${FIRST_RUN_NOTE}`) : 0),
  });

  return (
    <Box
      borderStyle={borderStyleFor('round')}
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
              {frame} {BOOT_MANIFEST_TITLE}
            </Text>
          </Text>
          <Text color={theme.textDim}>
            <TextSpans
              parts={seatLine.map((span) => ({
                text: span.text,
                tone: span.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[span.seat],
              }))}
            />
            {notes.length > 0 && (
              <Text color={theme.textDim}>
                {SOFT_SEP}
                {FIRST_RUN_NOTE}
              </Text>
            )}
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
  readClipboardImage,
  listProjectFiles,
}: HomeScreenProps) {
  const theme = useTheme();
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const [{ cols, rows }, { sessions, totalCount }, { projectDir }, dock] = useStores(
    terminalSizeStore,
    sessionsStore,
    configStore,
    inputHeightStore,
  );
  const selectionError = sessionSelectStore.use((s) => s.error);
  const noConfig = configStore.use((state) => state.revision === null);
  const approvalPending = approvalPromptStore.use((state) => state.status === 'pending');
  const discoveryNotice = detectionStore.use((s) => {
    const r = s.refresh;
    if (!(r.readiness.refreshing || r.modelsDev.refreshing || r.cliModels.refreshing)) return null;
    return r.readiness.fetchedAt === null ? 'cold' : 'warm';
  });
  const startPreparation = useStartPreparation<Extract<DraftSubmission, { ok: true }>>({
    prepare: async (submission, signal) => {
      const current = configStore.get();
      if (!current.config || !current.projectDir) {
        return { kind: 'failed', error: appPreparationError.configNotLoaded() };
      }
      return deps.prepareExecution({
        projectDir: current.projectDir,
        feature: submission.message.displayText,
        plannerContext: submission.plannerContext || undefined,
        ...(submission.message.attachedInputs.length > 0 && {
          attachedInputs: submission.message.attachedInputs,
        }),
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
        run: readRunRecord(execution.session.ref),
        execution: { kind: 'local', prepared: execution },
      });
    },
  });
  const [sessionsFocused, setSessionsFocused] = useState(false);
  const preparationState = startPreparation.state;
  const isPreparing = preparationState.kind === 'preparing';
  // The word is the submitted request's, not this screen's — a check launched by the CLI before
  // the mount is the same wait, and Home is the screen it lands on.
  const checkingStage = preparationStore.use((state) =>
    state.kind === 'checking' ? state.stage : null,
  );
  const showPreparationPanel =
    approvalPending || preparationState.kind === 'blocked' || preparationState.kind === 'failed';
  const preliminaryLayout = getHomeLayout({
    cols,
    rows,
    sessionCount: totalCount,
    sessionsFocused: false,
    dockRows: dock.rows,
    noConfig,
  });
  const focusedLayout = getHomeLayout({
    cols,
    rows,
    sessionCount: totalCount,
    sessionsFocused: true,
    dockRows: dock.rows,
    noConfig,
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
  const { frame: preparationFrame } = useSpinnerFrame(checkingStage !== null);

  // Another process can end or finish a run, so home reads the list again whenever it shows.
  useEffect(() => {
    sessionsStore.refresh();
  }, []);

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
  const onStartWorkflow = (submission: Extract<DraftSubmission, { ok: true }>) => {
    observePreparationCleanup(startPreparation.submit(submission));
  };

  useInput(
    (_input, key) => {
      if (key.escape) startPreparation.cancel(closeApprovalPrompt);
    },
    { isActive: isPreparing && !hasOverlay && !showPreparationPanel },
  );

  let homeHint: string | undefined;
  if (!interactionBlocked) {
    homeHint = DEFAULT_HOME_HINT;
    if (canFocus) homeHint = HOME_HINT;
    // The notice borrows the reserved hint line instead of adding a row, so it
    // never moves the layout.
    if (hintNotice) {
      homeHint = `${refreshFrame} ${
        discoveryNotice === 'cold' ? BOOT_MANIFEST_TITLE : REFRESHING_TOOLS_TITLE
      }`;
    }
    if (sessionsActive) homeHint = RECENT_SESSIONS_HINT;
  }

  // The check the user is waiting on borrows the same reserved row, so the status appears and goes
  // without moving anything above or below it. Only an attempt this screen owns can be given up,
  // so only that one advertises the key.
  const preparationStatus =
    checkingStage === null || interactionBlocked
      ? undefined
      : `${preparationFrame} ${checkingStage}${isPreparing ? `${SOFT_SEP}esc cancel` : ''}`;

  return (
    <>
      {showPreparationPanel && (
        <StartPreparationPanel
          state={startPreparation.state}
          onRetry={() => observePreparationCleanup(startPreparation.retry())}
          onBack={() => startPreparation.cancel(closeApprovalPrompt)}
          onOpenSettings={() => overlayStore.open('settings')}
          approvalPrompt={approvalPending ? <ApprovalPrompt /> : undefined}
        />
      )}
      {/* The panel covers the screen rather than replacing it, so what is typed here outlives a
          blocked or failed check and is still in the composer when the panel stands down. */}
      <Box display={showPreparationPanel ? 'none' : 'flex'}>
        <ScreenShell justifyContent="flex-start" alignItems="center">
          <Box flexDirection="column" width={layout.width} height="100%">
            <Box flexDirection="column" flexGrow={1} overflowY="hidden" alignItems="center">
              <Box flexDirection="column" width={layout.width} gap={1} flexShrink={0}>
                {layout.showLogo && (
                  <Box flexDirection="column" alignItems="center" flexShrink={0}>
                    <Text color={theme.accent}>{getLogo(layout.logoTier)}</Text>
                  </Box>
                )}

                <HomeSeatBlock rows={rows} width={layout.width} />

                {noConfig && (
                  <Box paddingLeft={MARK_SLOT_CELLS}>
                    <Text color={theme.textDim}>{NO_CONFIG_NOTICE}</Text>
                  </Box>
                )}

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
                    width={layout.width}
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
                {discoveryPanelFits && <DiscoveryPanel width={layout.width} />}
              </Box>
            </Box>

            <Box flexDirection="column" marginBottom={layout.inputBottomMargin} flexShrink={0}>
              <Composer
                disabled={interactionBlocked || sessionsActive}
                submitKeepsDraft
                onSubmit={onStartWorkflow}
                onRuntimeCommand={onRuntimeCommand}
                commands={commands}
                mode="normal"
                hint="Describe your feature…"
                currentScreen="home"
                width={layout.width}
                keepPlaceholderWhileFocused
                homeHint={homeHint}
                homeStatus={preparationStatus}
                readClipboardImage={readClipboardImage}
                listProjectFiles={listProjectFiles}
              />
            </Box>
          </Box>
        </ScreenShell>
      </Box>
    </>
  );
}
