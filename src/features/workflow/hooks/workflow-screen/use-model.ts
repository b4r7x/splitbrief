import { useEffect, useEffectEvent } from 'react';
import { type RewindTarget, setResumeHandler, setRewindHandler } from '../../handlers.js';
import { sessionDir } from '../../../../core/paths.js';
import type { CopyResult, CopyTarget } from '../../../../core/runtime/commands/types.js';
import type { Focus } from '../../../../stores/ui/focus.js';
import { useInputMode } from '../use-input-mode.js';
import { useRunContinue } from '../use-run-continue.js';
import { useRunLoop, type RunWorkflowFn } from '../use-run-loop.js';
import { createReviewInputHandler, type ReviewInputEffects } from '../../review-parser.js';
import { useWorkflowKeys } from '../use-keys.js';
import { useBriefReviewKeys } from '../use-brief-review-keys.js';
import { resolveInputHint } from '../../input-hints.js';
import { continueRun } from '../../../../engine/orchestrator/run/continue.js';
import { configStore } from '../../../../stores/project/config.js';
import { skillsStore } from '../../../../stores/project/skills.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { routerStore } from '../../../../stores/navigation/router.js';
import {
  continueRunInPlace,
  type SessionSelectDeps,
} from '../../../../stores/navigation/session-select.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { feedbackStore } from '../../../../stores/ui/feedback.js';
import { stopStore } from '../../../../stores/workflow/stop.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import { approvalPromptStore } from '../../../../stores/approval-prompt/prompt.js';
import { useStores } from '../../../../stores/use-stores.js';
import { getShowSpend } from '../../../../core/config/accessors/values.js';
import { atRestComposer, atRestRailStages } from '../../at-rest.js';
import { deriveSummaryView } from '../../closed/view-model.js';
import { hydrateResume } from '../../resume-hydration.js';
import { rewindSavedState } from '../../rewind-handler.js';
import { addTuiEvent } from '../../tui-sink.js';
import { useWorkflowInlineEdit } from './use-inline-edit.js';

/** Blank Enter never resumes a parked brief, so the row says what does. */
export const PARKED_EMPTY_SUBMIT_HINT = 'type instructions or /resume';

export interface WorkflowScreenDeps {
  runWorkflow?: RunWorkflowFn | undefined;
  /** The app's preparation composition root; continuing a run at rest re-prepares its tools. */
  sessionSelect?: SessionSelectDeps | undefined;
  /**
   * The editor process and the planner queue. One port serves both routes into an editor —
   * the `edit-file` review command and the external-edit request the raw editor's ctrl+o
   * files — so neither can start a process the screen's owner did not supply.
   */
  reviewInput?: ReviewInputEffects | undefined;
}

interface UseWorkflowScreenOptions {
  onRuntimeCommand: (command: string) => void;
  copyTarget?: ((target: CopyTarget) => Promise<CopyResult>) | undefined;
  canCopyFocused?: ((focus: Focus | null) => boolean) | undefined;
  deps?: WorkflowScreenDeps | undefined;
}

export function useWorkflowScreen({
  onRuntimeCommand,
  copyTarget,
  canCopyFocused,
  deps,
}: UseWorkflowScreenOptions) {
  const configuredProjectDir = configStore.use((s) => s.projectDir);
  const showSpend = configStore.use((s) => s.config === null || getShowSpend(s.config));
  const [skills] = useStores(skillsStore);
  const selectedSkillMetas = skills.available.filter((m) => skills.selected.has(m.id));
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const route = routerStore.use((s) => s);
  const workflowRoute = route.screen === 'workflow' ? route : undefined;
  const record = workflowRoute?.run;
  const execution = workflowRoute?.execution;
  const local = execution?.kind === 'local' ? execution : undefined;
  const prepared = local?.prepared;
  const projectDir = record?.ref.projectDir ?? configuredProjectDir;

  const inputMode = useInputMode();
  const review = createReviewInputHandler(inputMode, deps?.reviewInput);

  const [{ cancelled, phase }, { filePath: reviewFilePath }] = useStores(
    lifecycleStore,
    reviewStore,
  );

  const atRestRecord = execution?.kind === 'at-rest' ? record : undefined;

  // One continuation path for a run at rest: the engine decides whether the run can be picked up,
  // the preparation attempt re-enters it in place, and the screen never moves. A rewind is written
  // onto the saved state first, so the run re-enters at the step it rewound to.
  const continueAtRest = (text: string, run = atRestRecord, rewind?: RewindTarget): void => {
    const sessionSelect = deps?.sessionSelect;
    if (run === undefined || sessionSelect === undefined) return;
    const outcome = continueRun({
      ref: run.ref,
      ...(text.trim() === '' ? {} : { steer: text }),
      deps: {
        resumeParked: () => false,
        loadState: hydrateResume,
        restart: ({ state, steer }) => {
          let entry = state;
          if (rewind !== undefined) {
            const rewound = rewindSavedState(run.ref, rewind, state);
            if (rewound === undefined) return;
            addTuiEvent(rewound.event);
            entry = rewound.next;
          }
          void continueRunInPlace({
            record: run,
            state: entry,
            ...(steer !== undefined && { steer }),
            deps: sessionSelect,
          });
        },
      },
    });
    if (outcome.kind === 'refused') feedbackStore.setError(outcome.message);
  };

  const continuation = useRunContinue({ prepared, inputMode });
  const runner = useRunLoop({
    prepared,
    ...(local?.steer !== undefined && { steer: local.steer }),
    selectedSkills: selectedSkillMetas,
    inputMode,
    continuation,
    runWorkflow: deps?.runWorkflow,
    continueAtRest: (run) => continueAtRest('', run),
  });

  const approvalPromptState = approvalPromptStore.use((s) => s);
  const promptPending = approvalPromptState.status === 'pending';

  const activeSessionId = record?.ref.sessionId ?? runner.sessionId;
  const sessionDirPath =
    activeSessionId === undefined ? undefined : sessionDir(projectDir, activeSessionId);

  const { fieldSessionOwned } = useWorkflowInlineEdit({
    promptPending,
    inputMode,
    sessionDirPath,
    openExternalEditor: deps?.reviewInput?.openExternalEditor,
  });

  const globalKeysActive = !promptPending && !fieldSessionOwned;
  useWorkflowKeys({ isActive: globalKeysActive });
  const navigateBriefReview = useBriefReviewKeys({
    isActive: globalKeysActive,
    copyTarget,
    canCopyFocused,
  });

  const parked = stopStore.use((s) => s.phase === 'parked');

  const composer = atRestRecord === undefined ? null : atRestComposer(atRestRecord);
  const closedView =
    atRestRecord === undefined ? null : deriveSummaryView({ record: atRestRecord, showSpend });
  const closed = atRestRecord !== undefined && atRestRecord.status.kind === 'closed';

  const resumeAtRest = useEffectEvent(continueAtRest);
  useEffect(() => {
    if (atRestRecord === undefined) return;
    setResumeHandler((text) => resumeAtRest(text));
    setRewindHandler((request) => resumeAtRest('', atRestRecord, request));
    return () => {
      setResumeHandler(null);
      setRewindHandler(null);
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
    navigateBriefReview,
    startedAt: runner.startedAt,
    /** The run on screen, at rest; undefined while a local process is driving it. */
    atRestRecord,
    closed,
    closedView,
    railStages: atRestRecord === undefined ? undefined : atRestRailStages(atRestRecord),
    continuable: composer?.continuable ?? false,
    handleInput,
    handleRuntimeCommand: onRuntimeCommand,
    // A bare Enter does what the placeholder says it does: continues a run that can be continued,
    // and goes home from one that cannot.
    onEmptySubmit:
      atRestRecord !== undefined
        ? composer?.continuable === true
          ? () => continueAtRest('')
          : () => routerStore.navigate({ to: 'home' })
        : parked
          ? () => feedbackStore.setMessage(PARKED_EMPTY_SUBMIT_HINT)
          : undefined,
    inputHint,
    commandsOnly: composer?.commandsOnly ?? false,
    questionEpoch: inputMode.questionEpoch,
  };
}
