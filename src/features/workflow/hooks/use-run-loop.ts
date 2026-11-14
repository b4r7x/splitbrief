import { useRef, useEffect, useEffectEvent } from 'react';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { RunRecord } from '../../../core/sessions/run/record.js';
import { readRunRecord } from '../../../core/sessions/run/record-io.js';
import { hydrateFromState } from '../../../stores/workflow/actions/hydrate.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { preparationStore } from '../../../stores/navigation/preparation.js';
import { configStore } from '../../../stores/project/config.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { runWorkflow } from '../../../engine/orchestrator/run/workflow.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { publishRetainedWorkspaceNotice } from '../../../engine/orchestrator/isolation/retention.js';
import { addTuiEvent } from '../tui-sink.js';
import type { PreparedExecution } from '../../../engine/runners/prepare-execution/prepared.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare.js';
import {
  setCancelHandler,
  setStopHandler,
  setResumeHandler,
  clearAllHandlers,
} from '../run-requests/registry.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { markWorkflowPaused } from '../../../stores/workflow/actions/pause.js';
import { stopInProgress, stopStore } from '../../../stores/workflow/stop.js';
import {
  createProcessScope,
  onProcessRegistryChange,
  processScopeCount,
  runInProcessScope,
  type ProcessScope,
} from '../../../lib/process/registry.js';
import { closeApprovalPrompt } from '../../../stores/prompts/approval.js';
import type { UseInputModeResult } from './use-input-mode.js';
import {
  openStopSheetOverEmptyComposer,
  runTuiWorkflow,
  type ContinueAtRest,
} from '../run-loop/start.js';
import type { UseRunContinueResult } from './use-run-continue.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';

export type RunWorkflowFn = typeof runWorkflow;
export type PrepareExecutionFn = typeof prepareExecution;

interface UseRunLoopOptions {
  prepared?: PreparedExecution | undefined;
  /** What the operator typed to continue this run; it seeds the first step of this re-entry. */
  steer?: UserMessageInput | undefined;
  /** Set when the run continues by itself after a boundary park that only changed a seat. */
  resumeCause?: 'seat-change' | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
  /** How this run is re-entered — the loop reads its state. */
  continuation: UseRunContinueResult;
  runWorkflow?: RunWorkflowFn | undefined;
  prepareExecution?: PrepareExecutionFn | undefined;
  /**
   * How a run at rest continues: it is re-prepared from the saved config and re-entered in place,
   * with the words it was continued with. A run that stopped itself at a brief or review boundary
   * to pick up a changed seat names that cause. A refusal comes back as its reason, and the caller
   * shows it.
   */
  continueAtRest?: ContinueAtRest | undefined;
}

/**
 * The run in the React life cycle: `runTuiWorkflow` for each re-entry in its own process scope, the
 * abort when the screen leaves it, the hand-off of the run at rest, and the process-registry
 * watcher that keeps the stop byline honest. Everything about re-entering the run lives in
 * `useRunContinue`.
 */
export function useRunLoop({
  prepared,
  steer,
  resumeCause,
  selectedSkills,
  inputMode,
  continuation,
  runWorkflow: runWorkflowFn = runWorkflow,
  prepareExecution: prepareExecutionFn = prepareExecution,
  continueAtRest,
}: UseRunLoopOptions): void {
  const abortedRef = useRef(false);
  const processScopeRef = useRef<ProcessScope | undefined>(undefined);
  const retentionNoticeHandled = useRef(true);
  const { runId, handleResume } = continuation;

  const startWorkflow = useEffectEvent((controller: AbortController, scope: ProcessScope) => {
    if (prepared === undefined) return undefined;
    return runTuiWorkflow({
      prepared,
      steer,
      resumeCause,
      selectedSkills,
      inputMode,
      continuation,
      runWorkflow: runWorkflowFn,
      prepareExecution: prepareExecutionFn,
      continueAtRest,
      abortedRef,
      retentionNoticeHandled,
      controller,
      scope,
      settleRun,
    });
  });

  useEffect(() => {
    if (prepared === undefined) return undefined;

    abortedRef.current = false;
    const controller = new AbortController();
    const scope = createProcessScope();
    processScopeRef.current = scope;
    setResumeHandler((text) => handleResume(text));
    void runInProcessScope(scope, () => startWorkflow(controller, scope));
    return () => {
      abortedRef.current = true;
      inputMode.resetMode();
      controller.abort();
      clearAllHandlers();
      closeApprovalPrompt();
    };
  }, [prepared, runId]);

  useEffect(() => {
    const update = () => {
      const stop = stopStore.get();
      if (!stopInProgress(stop)) return;
      const { phase } = stop;
      const scope = processScopeRef.current;
      if (scope !== undefined && processScopeCount(scope) > 0) {
        if (phase !== 'terminating') stopStore.markTerminating();
      } else if (phase !== 'settling') stopStore.markSettling();
    };
    const offProcesses = onProcessRegistryChange(update);
    const offStop = stopStore.subscribe(update);
    update();
    return () => {
      offProcesses();
      offStop();
    };
  }, []);

  // The run loop returned: the run is at rest, on the screen it never left. One re-read of the
  // record is the whole hand-off — the screen paints open or closed from it, and the session list
  // shows what it shows everywhere else.
  const settleRun = async (
    ref: PreparedExecution['session']['ref'],
    handoff: boolean,
  ): Promise<RunRecord> => {
    const record = readRunRecord(ref, configStore.reviewNone());
    if (handoff && !retentionNoticeHandled.current && record.hydration.kind === 'loaded') {
      await publishRetainedWorkspaceNotice({
        ...ref,
        state: record.hydration.state,
        bus: createRecoveryBus({ ...ref, sink: addTuiEvent }),
      });
      retentionNoticeHandled.current = true;
    }
    const wasStopping = stopStore.get().intent !== 'none';
    setStopHandler(null);
    setCancelHandler(null);
    // The run is at rest from here. A steer that waits for this stop to land continues it there,
    // not on the execution that just returned.
    setResumeHandler((steer) => continueAtRest?.(record, steer));
    inputMode.resetMode();
    routerStore.updateRun({ run: record, execution: { kind: 'at-rest' } });
    sessionsStore.refresh();
    if (wasStopping) {
      if (record.status.kind === 'closed' || record.status.kind === 'ready-to-apply') {
        stopStore.end();
      } else {
        markWorkflowPaused();
        stopStore.park('mid-brief', null, null);
      }
      // A queued leave/quit is delivered by the stop observer before offering actions here. A run
      // whose final review passed before the stop reached it is complete, not stopped: the stop then
      // stands down, and the closed run's own byline speaks for it. A workspace run that passed
      // review lands on the result menu the same way, with no stop sheet over it. A draft keeps the
      // keys too: the ⏎ that ends it belongs to the composer, not to the row Resume. A run that the
      // steer behind this stop continues already has its tools in preparation, and gets no sheet.
      if (
        (record.status.kind === 'closed' && record.status.as === 'complete') ||
        record.status.kind === 'ready-to-apply'
      ) {
        stopStore.reset();
        // End run marks the lifecycle cancelled at the keypress, and no later event lifts that
        // mark; the record says the run completed, and the record wins.
        if (record.hydration.kind === 'loaded')
          hydrateFromState(record.hydration.state, configStore.reviewNone());
      } else if (
        routerStore.get().screen === 'workflow' &&
        overlayStore.get().active === 'none' &&
        preparationStore.get().kind === 'idle'
      )
        openStopSheetOverEmptyComposer();
    }
    return record;
  };
}
