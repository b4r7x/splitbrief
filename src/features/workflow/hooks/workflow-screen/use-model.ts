import { useEffect, useEffectEvent } from 'react';
import { existsSync, watchFile, unwatchFile, type Stats } from 'node:fs';
import { join } from 'node:path';
import {
  LOCKFILE,
  SESSION_LOG_FILE,
  STATE_FILE,
  SUMMARY_FILE,
  sessionDir,
} from '../../../../core/paths.js';
import { requestResume, rereadRunAtRest, setResumeHandler } from '../../handlers.js';
import { useInputMode } from '../use-input-mode.js';
import { useRunContinue } from '../use-run-continue.js';
import { useRunLoop, type RunWorkflowFn } from '../use-run-loop.js';
import { createReviewInputHandler, type ReviewInputEffects } from '../../review-parser.js';
import { useWorkflowKeys } from '../use-keys.js';
import { resolveInputHint } from '../../input-hints.js';
import { continueRun } from '../../../../engine/orchestrator/run/continue.js';
import { skillsStore } from '../../../../stores/project/skills.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { routerStore } from '../../../../stores/navigation/router.js';
import {
  continueRunInPlace,
  type SessionSelectDeps,
} from '../../../../stores/navigation/session-select.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { recoveryNoticeStore } from '../../../../stores/workflow/recovery-notice.js';
import { feedbackStore } from '../../../../stores/ui/feedback.js';
import { stopStore } from '../../../../stores/workflow/stop.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import { approvalPromptStore } from '../../../../stores/approval-prompt/prompt.js';
import { useStores } from '../../../../stores/use-stores.js';
import { atRestComposer, atRestRailStages } from '../../at-rest.js';
import { deriveSummaryView } from '../../closed/view-model.js';
import { hydrateResume } from '../../resume-hydration.js';
import { useWorkflowInlineEdit } from './use-inline-edit.js';
import { plainUserMessage, type UserMessageInput } from '../../../../core/types/user-input.js';

export interface WorkflowScreenDeps {
  runWorkflow?: RunWorkflowFn | undefined;
  /** The app's preparation composition root; continuing a run at rest re-prepares its tools. */
  sessionSelect?: SessionSelectDeps | undefined;
  /**
   * The editor process and the planner queue. The editor overlay's ctrl+o is the one route
   * into an external editor, so it cannot start a process the screen's owner did not supply.
   */
  reviewInput?: ReviewInputEffects | undefined;
}

interface UseWorkflowScreenOptions {
  onRuntimeCommand: (command: string) => void;
  deps?: WorkflowScreenDeps | undefined;
}

export function useWorkflowScreen({ onRuntimeCommand, deps }: UseWorkflowScreenOptions) {
  const [skills] = useStores(skillsStore);
  const selectedSkillMetas = skills.available.filter((m) => skills.selected.has(m.id));
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const route = routerStore.use((s) => s);
  const workflowRoute = route.screen === 'workflow' ? route : undefined;
  const record = workflowRoute?.run;
  const execution = workflowRoute?.execution;
  const local = execution?.kind === 'local' ? execution : undefined;
  const prepared = local?.prepared;

  const inputMode = useInputMode();
  const review = createReviewInputHandler(inputMode, deps?.reviewInput);

  const [{ cancelled, phase, restored }, { filePath: reviewFilePath }] = useStores(
    lifecycleStore,
    reviewStore,
  );
  const recoveryOpen = recoveryNoticeStore.use((s) => s.issue !== null);

  const atRestRecord = execution?.kind === 'at-rest' ? record : undefined;
  const atRestProjectDir = atRestRecord?.ref.projectDir;
  const atRestSessionId = atRestRecord?.ref.sessionId;

  useEffect(() => {
    if (atRestProjectDir === undefined || atRestSessionId === undefined) return;
    const ref = { projectDir: atRestProjectDir, sessionId: atRestSessionId };
    const directory = sessionDir(ref.projectDir, ref.sessionId);
    const controller = new AbortController();
    const refresh = () => {
      const current = routerStore.get();
      if (current.screen !== 'workflow' || current.execution.kind !== 'at-rest') return;
      void rereadRunAtRest(ref, controller.signal);
    };
    const files = [STATE_FILE, LOCKFILE, SESSION_LOG_FILE, SUMMARY_FILE].map((file) =>
      join(directory, file),
    );
    const changed = (current: Stats, previous: Stats) => {
      if (current.nlink !== 0 || previous.nlink !== 0) refresh();
    };
    for (const file of files) {
      watchFile(file, { persistent: false, interval: 100 }, changed);
    }
    if (existsSync(join(directory, STATE_FILE))) refresh();
    return () => {
      controller.abort();
      for (const file of files) unwatchFile(file, changed);
    };
  }, [atRestProjectDir, atRestSessionId]);

  // One continuation path for a run at rest: the engine decides whether the run can be picked up,
  // the preparation attempt re-enters it in place, and the screen never moves.
  const continueAtRest = (message: UserMessageInput, run = atRestRecord): void => {
    const sessionSelect = deps?.sessionSelect;
    if (run === undefined || sessionSelect === undefined) return;
    const outcome = continueRun({
      ref: run.ref,
      ...(message.text.trim() === '' ? {} : { steer: message }),
      deps: {
        resumeParked: () => false,
        loadState: hydrateResume,
        restart: ({ state, steer }) => {
          void continueRunInPlace({
            record: run,
            state,
            ...(steer !== undefined && { steer }),
            deps: sessionSelect,
          });
        },
      },
    });
    if (outcome.kind !== 'refused') return;
    if (outcome.reason === 'closed' || outcome.reason === 'ready-to-apply')
      void rereadRunAtRest(run.ref);
    feedbackStore.setError(outcome.message);
  };

  const continuation = useRunContinue({ prepared, inputMode });
  useRunLoop({
    prepared,
    ...(local?.steer !== undefined && { steer: local.steer }),
    selectedSkills: selectedSkillMetas,
    inputMode,
    continuation,
    runWorkflow: deps?.runWorkflow,
    continueAtRest: (run) => continueAtRest(plainUserMessage(''), run),
  });

  const approvalPromptState = approvalPromptStore.use((s) => s);
  const promptPending = approvalPromptState.status === 'pending';

  useWorkflowInlineEdit({
    inputMode,
    openExternalEditor: deps?.reviewInput?.openExternalEditor,
  });

  useWorkflowKeys({ isActive: !promptPending });

  const parked = stopStore.use((s) => s.phase === 'parked');

  const composer = atRestRecord === undefined ? null : atRestComposer(atRestRecord);
  const closedView =
    atRestRecord === undefined ? null : deriveSummaryView({ record: atRestRecord });
  const closed = atRestRecord !== undefined && atRestRecord.status.kind === 'closed';
  // A run continued into Apply keeps the rail it rested with until the engine re-enters it or a
  // halt opens; the live rail cannot tell a run about to resume into Apply from a finished one.
  const railRecord =
    atRestRecord ??
    (local !== undefined &&
    restored === true &&
    !recoveryOpen &&
    record?.status.kind === 'open' &&
    record.status.resumeAt.kind === 'apply'
      ? record
      : undefined);

  const resumeAtRest = useEffectEvent(continueAtRest);
  useEffect(() => {
    if (atRestRecord === undefined) return;
    setResumeHandler((text) => resumeAtRest(text));
    return () => {
      setResumeHandler(null);
    };
  }, [atRestRecord]);

  // A parked brief and a run at rest continue the same way — one path, which settles the park or
  // re-enters the run and says so when it cannot.
  const handleInput =
    atRestRecord !== undefined
      ? continueAtRest
      : parked || cancelled
        ? continuation.handleResume
        : review.handleInput;

  const inputHint =
    composer !== null
      ? composer.placeholder
      : resolveInputHint({ inputHint: inputMode.hint, inputMode: inputMode.mode });

  return {
    hasOverlay,
    phase,
    cancelled,
    inputMode,
    reviewFilePath,
    approvalPromptState,
    promptPending,
    /** The run on screen, at rest; undefined while a local process is driving it. */
    atRestRecord,
    closed,
    closedView,
    railStages: railRecord === undefined ? undefined : atRestRailStages(railRecord),
    continuable: composer?.continuable ?? false,
    handleInput,
    handleRuntimeCommand: onRuntimeCommand,
    // A bare Enter does what the placeholder says it does: continues a run that can be continued,
    // and goes home from one that cannot. A parked run continues as `/resume` does.
    onEmptySubmit:
      atRestRecord !== undefined
        ? composer?.continuable === true
          ? () => continueAtRest(plainUserMessage(''))
          : () => routerStore.navigate({ to: 'home' })
        : parked
          ? () => requestResume(plainUserMessage(''))
          : undefined,
    inputHint,
    commandsOnly: composer?.commandsOnly ?? false,
    questionEpoch: inputMode.questionEpoch,
  };
}
