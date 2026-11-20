import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { useEffect, useState } from 'react';
import { Box } from 'ink';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { prepareExecution } from '../../engine/runners/prepare-execution/prepare.js';
import { LOCKFILE_PING_INTERVAL_MS } from '../../engine/orchestrator/run/heartbeat.js';
import { Composer } from '../../components/composer/view.js';
import type { DraftSubmission } from '../../core/composer/submission.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { HomeSeatBlock, minimumHomeSeatRows } from '../../features/home/components/seat-block.js';
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
import { composerLiveStore } from '../../stores/ui/composer-live.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { saveHomeDraft } from '../../stores/ui/session-drafts.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { useStores } from '../../stores/use-many.js';
import type { Session } from '../../core/schemas/session.js';
import { readRunRecord } from '../../core/sessions/run/record-io.js';
import {
  handleSessionSelect,
  type SessionSelectDeps,
} from '../../stores/navigation/session-select.js';
import { MARK_SLOT_CELLS } from '../../components/row-leading.js';
import { deriveHomeLayoutState, homeWidth, NO_CONFIG_NOTICE } from '../../features/home/layout.js';
import { deriveHomeComposerHint } from '../../features/home/hint.js';
import { getLogo } from '../../features/home/logo.js';
import { deriveHomeToolCheck } from '../../features/home/tool-check.js';
import { useRecentSessionsFocus } from '../../features/home/recent-sessions/use-focus.js';
import { sessionSelectDeps } from '../prepare-resume.js';
import { checkingStatusText, prepareStart } from '../prepare-start.js';
import { PreparationGate } from '../preparation-gate.js';
import { useStartPreparation } from '../../features/start-preparation/use-controller.js';
import { usePreparationKeys } from '../../features/start-preparation/use-preparation-keys.js';
import {
  panelModel,
  preparationNotice,
  preparationHint,
} from '../../components/preparation-problem.js';
import { useClosePromptOnLeave } from '../../features/start-preparation/use-close-prompt-on-leave.js';
import { observePreparationCleanup } from '../../features/start-preparation/observe-cleanup.js';
import { approvalPromptStore, closeApprovalPrompt } from '../../stores/prompts/approval.js';
import type { readClipboardImage } from '../../core/attachments/clipboard-image.js';
import type { listProjectFiles } from '../../lib/fs/listing.js';
import { ToolCheckBox } from '../../features/home/components/tool-check-box.js';

import { feedbackStore } from '../../stores/ui/feedback.js';

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
  const config = configStore.useConfig();
  const noConfig = configStore.use((state) => state.revision === null);
  const approvalPending = approvalPromptStore.use((state) => state.status === 'pending');
  const toolCheck = detectionStore.use((s) => deriveHomeToolCheck(s.refresh));
  const startPreparation = useStartPreparation<{
    submission: Extract<DraftSubmission, { ok: true }>;
    draft: DraftDocument;
  }>({
    prepare: ({ submission }, signal) => {
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
    onPrepared: (execution, { draft }) => {
      // The composer keeps a sent request for a start that is refused; a run that starts takes it.
      if (composerLiveStore.get().document === draft)
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
  const problem = panelModel(preparationState);
  const showPreparationPanel = approvalPending;
  const {
    layout,
    hasRoomForSessions,
    canFocus,
    sessionsActive,
    discoveryPanelFits,
    hintNotice,
    seatLineRows,
  } = deriveHomeLayoutState({
    cols,
    rows,
    sessionCount: totalCount,
    listedSessions: sessions.length,
    minimumSeatRows: minimumHomeSeatRows(config, homeWidth(cols), rows),
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

  useClosePromptOnLeave();

  useRecentSessionsFocus({
    hasSessions: canFocus,
    hasOverlay: interactionBlocked || isPreparing,
    focused: sessionsActive,
    onEnter: () => setSessionsFocused(true),
  });
  const onStartWorkflow = (submission: Extract<DraftSubmission, { ok: true }>) => {
    observePreparationCleanup(
      startPreparation.submit({ submission, draft: composerLiveStore.get().document }),
    );
  };

  usePreparationKeys({
    active: !sessionsActive && !approvalPending && (isPreparing || problem !== null),
    problem,
    onCancel: () => startPreparation.cancel(closeApprovalPrompt),
  });

  const { homeHint, homeNotice, standingNotice } = deriveHomeComposerHint({
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
      {showPreparationPanel && <PreparationGate />}
      <Box display={showPreparationPanel ? 'none' : 'flex'}>
        <ScreenShell justifyContent="flex-start" alignItems="center">
          <Box flexDirection="column" width={layout.width} height="100%">
            <Box flexDirection="column" flexGrow={1} overflowY="hidden" alignItems="center">
              <Box flexDirection="column" width={layout.width} gap={1} flexShrink={0}>
                {layout.heading !== null && layout.heading !== 'wordmark' && (
                  <Box flexDirection="column" alignItems="center" flexShrink={0}>
                    <Text color={theme.accent}>{getLogo(layout.heading)}</Text>
                  </Box>
                )}

                {/* The wordmark sits on the crew block's first row, with no gap under it. */}
                <Box flexDirection="column" flexShrink={0}>
                  {layout.heading === 'wordmark' && (
                    <Box justifyContent="center">
                      <Text color={theme.accent} bold>
                        {getLogo('wordmark')}
                      </Text>
                    </Box>
                  )}
                  <HomeSeatBlock rows={rows} width={layout.width} seatLineRows={seatLineRows} />
                </Box>

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
                      handleSessionSelect(
                        session,
                        projectDir,
                        deps.sessionSelect,
                        feedbackStore.setError,
                      )
                    }
                    onClose={() => setSessionsFocused(false)}
                    hasOverlay={interactionBlocked}
                    width={layout.width}
                  />
                )}
              </Box>
              <Box
                flexGrow={1}
                flexDirection="column"
                justifyContent="center"
                alignItems="center"
                overflow="hidden"
              >
                {discoveryPanelFits && <ToolCheckBox />}
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
                homeNotice={
                  problem && !sessionsActive
                    ? preparationHint(problem, layout.width, 'composer')
                    : homeNotice
                }
                homeStandingNotice={
                  problem && !sessionsActive ? preparationNotice(problem) : standingNotice
                }
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
