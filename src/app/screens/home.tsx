import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { useEffect, useState } from 'react';
import { Box } from 'ink';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { prepareExecution } from '../../engine/runners/prepare-execution/prepare.js';
import { LOCKFILE_PING_INTERVAL_MS } from '../../engine/orchestrator/run/heartbeat.js';
import { Composer } from '../../components/composer/view.js';
import type { DraftSubmission } from '../../core/composer/submission.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { HomeSeatBlock } from '../../features/home/components/seat-block.js';
import { RecentSessions } from '../../features/home/recent-sessions/panel.js';
import { useSpinnerFrame } from '../../hooks/use-spinner-frame.js';
import { useSlowProbeText } from '../../hooks/use-slow-probe-text.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { detectionStore } from '../../stores/discovery/detection.js';
import { overlayStore, selectHasOverlay } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { preparationStore, selectCheckingStage } from '../../stores/navigation/preparation.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { saveHomeDraft } from '../../stores/ui/session-drafts.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { useStores } from '../../stores/use-many.js';
import type { Session } from '../../core/schemas/session.js';
import { readRunRecord } from '../../core/sessions/run/record-io.js';
import {
  handleSessionSelect,
  type SessionSelectDeps,
  sessionSelectStore,
} from '../../stores/navigation/session-select.js';
import { MARK_SLOT_CELLS } from '../../components/row-leading.js';
import { deriveHomeLayoutState, NO_CONFIG_NOTICE } from '../../features/home/layout.js';
import { deriveHomeComposerHint } from '../../features/home/hint.js';
import { getLogo } from '../../features/home/logo.js';
import { deriveHomeToolCheck } from '../../features/home/tool-check.js';
import { useRecentSessionsFocus } from '../../features/home/recent-sessions/use-focus.js';
import { sessionSelectDeps } from '../prepare-resume.js';
import { checkingStatusText, prepareStart } from '../prepare-start.js';
import { PreparationGate } from '../preparation-gate.js';
import { useStartPreparation } from '../../features/start-preparation/use-controller.js';
import { useCancelKey } from '../../features/start-preparation/use-cancel-key.js';
import { useClosePromptOnLeave } from '../../features/start-preparation/use-close-prompt-on-leave.js';
import { observePreparationCleanup } from '../../features/start-preparation/observe-cleanup.js';
import { approvalPromptStore, closeApprovalPrompt } from '../../stores/prompts/approval.js';
import type { readClipboardImage } from '../../core/attachments/clipboard-image.js';
import type { listProjectFiles } from '../../lib/fs/listing.js';
import { ToolCheckBox } from '../../features/home/components/tool-check-box.js';

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

export function HomeScreen({
  commands,
  onRuntimeCommand,
  deps = defaultHomeScreenDeps,
  readClipboardImage,
  listProjectFiles,
}: HomeScreenProps) {
  const theme = useTheme();
  const hasOverlay = overlayStore.use(selectHasOverlay);
  const [{ cols, rows }, { sessions, totalCount }, { projectDir }, dock] = useStores(
    terminalSizeStore,
    sessionsStore,
    configStore,
    inputHeightStore,
  );
  const selectionError = sessionSelectStore.use((s) => s.error);
  const noConfig = configStore.use((state) => state.revision === null);
  const approvalPending = approvalPromptStore.use((state) => state.status === 'pending');
  const toolCheck = detectionStore.use((s) => deriveHomeToolCheck(s.refresh));
  const startPreparation = useStartPreparation<Extract<DraftSubmission, { ok: true }>>({
    prepare: (submission, signal) => {
      configStore.reloadIfChanged();
      return prepareStart(
        deps.prepareExecution,
        {
          feature: submission.message.displayText,
          plannerContext: submission.plannerContext || undefined,
          ...(submission.message.attachedInputs.length > 0 && {
            attachedInputs: submission.message.attachedInputs,
          }),
          allowRepoRunners: false,
        },
        signal,
      );
    },
    onPrepared: (execution) => {
      // The composer keeps a sent request for a start that is refused; a run that starts takes it.
      saveHomeDraft(configStore.get().projectDir, createDraftDocument(''));
      routerStore.navigate({
        to: 'workflow',
        run: readRunRecord(execution.session.ref, configStore.reviewNone()),
        execution: { kind: 'local', prepared: execution },
      });
    },
  });
  const [sessionsFocused, setSessionsFocused] = useState(false);
  const preparationState = startPreparation.state;
  const isPreparing = preparationState.kind === 'preparing';
  // The word is the submitted request's, not this screen's — a check launched by the CLI before
  // the mount is the same wait, and Home is the screen it lands on.
  const checkingStage = preparationStore.use(selectCheckingStage);
  const showPreparationPanel =
    approvalPending || preparationState.kind === 'blocked' || preparationState.kind === 'failed';
  const { layout, hasRoomForSessions, canFocus, sessionsActive, discoveryPanelFits, hintNotice } =
    deriveHomeLayoutState({
      cols,
      rows,
      sessionCount: totalCount,
      listedSessions: sessions.length,
      sessionsFocused,
      dockRows: dock.rows,
      noConfig,
      toolCheck,
    });
  const interactionBlocked = hasOverlay || showPreparationPanel;
  const { frame: refreshFrame } = useSpinnerFrame(
    hintNotice && (toolCheck === 'cold' || toolCheck === 'warm'),
  );
  const { frame: preparationFrame } = useSpinnerFrame(checkingStage !== null);
  const slowProbe = useSlowProbeText();

  // Another process can start, end or finish a run, and a hand edit can change config.yaml, so
  // home reads both again while it shows.
  useEffect(() => {
    const refresh = () => {
      sessionsStore.refresh();
      configStore.reloadShownConfig();
    };
    refresh();
    const timer = setInterval(refresh, LOCKFILE_PING_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!canFocus) setSessionsFocused(false);
  }, [canFocus]);

  useEffect(() => {
    if (!sessionsActive || !selectionError) return undefined;
    const timer = setTimeout(() => sessionSelectStore.clearError(), HOME_SELECTION_ERROR_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [sessionsActive, selectionError]);

  useClosePromptOnLeave();

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

  useCancelKey({
    preparing: isPreparing,
    takesPage: showPreparationPanel,
    onCancel: () => startPreparation.cancel(closeApprovalPrompt),
  });

  const { homeHint, homeNotice } = deriveHomeComposerHint({
    interactionBlocked,
    canFocus,
    sessionsActive,
    hintNotice,
    toolCheck,
    refreshFrame,
  });

  // The check the user is waiting on borrows the same reserved row, so the status appears and goes
  // without moving anything above or below it. Only an attempt this screen owns can be given up,
  // so only that one advertises the key.
  const preparationStatus = interactionBlocked
    ? undefined
    : checkingStatusText({
        frame: preparationFrame,
        stage: checkingStage,
        slowProbe,
        cancellable: isPreparing,
        width: layout.width,
      });

  return (
    <>
      {showPreparationPanel && (
        <PreparationGate
          state={startPreparation.state}
          retry={startPreparation.retry}
          onBack={() => startPreparation.cancel(closeApprovalPrompt)}
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
                {discoveryPanelFits && <ToolCheckBox width={layout.width} />}
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
                homeNotice={homeNotice}
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
