import { changedDeclaredFiles } from '../kept-work.js';
import type { Task } from '../../../core/schemas/task.js';
import {
  lineageAttemptsOf,
  type ChangedFilesSnapshot,
  type WorkflowState,
} from '../../../core/schemas/workflow.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { WorkflowContext } from '../types.js';
import type { ImplementerOptions, ImplementerResult } from '../../implementers/types.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import { createImplementerTextHandler } from '../events.js';
import { createStreamingFeed, noopStreamingSink } from './streaming-feed.js';
import type { StreamingSink } from './streaming-feed.js';
import { withContinuationLoop } from '../continuation.js';
import { gateChangedFiles, type GateChangedFilesDenial } from '../approval/gate-files.js';
import { persistApprovalEvidence } from '../evidence/persistence.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { isAbortError } from '../../../utils/abort.js';
import { implementerSeatAttempt, runSeatCall } from '../escalation/seat-wait.js';
import {
  addUsageAndSave,
  rebaseOnPersistedWorkflowState,
  recordBriefCorrection,
} from '../state-ops.js';
import { isResumableWorkspaceStop, retentionError } from '../isolation/retention.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';
import {
  absorbBuildCorrections,
  buildCorrectionInput,
  publishBuildImagesAsPaths,
  runWithCorrectionPasses,
} from '../queue/build-corrections.js';
import { settleMidCallDeliveries } from '../queue/mid-call.js';
import { formatMessageInput } from '../queue/prompt.js';
import { withAttemptRestoreScope } from './restore-scope.js';

/**
 * A restarted attempt is told about the declared files that already moved, so it
 * edits what is there instead of writing the file again from nothing.
 */
function changedDeclaredFilesNote(changed: readonly string[]): { extra?: string } {
  if (changed.length === 0) return {};
  return {
    extra: `These declared files changed since this brief started (an earlier attempt of this brief left them): ${changed.join(', ')}`,
  };
}

export type RunImplementationResult = {
  state: WorkflowState;
  implResult: ImplementerResult;
  workspace: AttemptWorkspace;
  preApplyApprovalDenied: boolean;
  preApplyApprovedFiles: string[];
};

export async function runImplementation(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  taskStartSnapshot: ChangedFilesSnapshot;
  setTrackedState: (s: WorkflowState) => void;
  recordApprovalDenial: (decision: GateChangedFilesDenial, message: string) => void;
  streamingSink?: StreamingSink | undefined;
  /** The error text the first attempt carries when it starts as a retry. */
  retryError?: string | undefined;
}): Promise<RunImplementationResult> {
  const { wctx, task, setTrackedState } = opts;
  const { projectDir, sessionId, config, callbacks, context } = wctx;
  let state = opts.state;

  const textHandler = createImplementerTextHandler(
    { bus: wctx.bus, phase: state.phase },
    wctx.implementer,
  );
  const writesDirectly = wctx.implementer.capabilities?.writesFiles === 'direct';

  let preApplyApprovalDenied = false;
  const preApplyApprovedFiles: string[] = [];

  const step = { kind: 'brief' as const, taskId: task.id, attempt: state.attempt };
  const seed = wctx.continuation?.take(step, hashTaskBrief([task]));
  let recordedCorrection: UserMessageInput | undefined;
  const recordCorrection = (message: UserMessageInput | undefined): void => {
    if (message === undefined || message === recordedCorrection) return;
    const text = formatMessageInput(message);
    if (!text.trim()) return;
    state = recordBriefCorrection({ projectDir, sessionId }, state, task.id, text, message.images);
    publishBuildImagesAsPaths({ ...wctx, state, taskId: task.id, count: message.images.length });
    recordedCorrection = message;
    setTrackedState(state);
  };
  state = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, state);
  recordCorrection(seed?.steer);
  const workspace: AttemptWorkspace = await wctx.isolation.acquire({
    role: 'implementer',
    config,
    resume: seed?.keepWorkspace === true,
  });
  // A direct writer narrates between tool calls; that text has one home, the transcript rows
  // textHandler feeds. The preview under `working on <file>…` is for the code an extractor
  // streams: it splits lines, not messages, so narration there would repeat and run together.
  const streamingFeed = createStreamingFeed(
    task.id,
    writesDirectly ? noopStreamingSink : (opts.streamingSink ?? noopStreamingSink),
  );

  let loop: { state: WorkflowState; value: ImplementerResult };
  try {
    loop = await withContinuationLoop<ImplementerResult>({
      ctx: {
        projectDir: workspace.projectDir,
        sessionId,
        persistRef: { projectDir, sessionId },
        callbacks,
        bus: wctx.bus,
        signal: wctx.signal,
        sinks: wctx.sinks,
      },
      state,
      step,
      ...(seed === undefined ? {} : { seed }),
      onStateChange: setTrackedState,
      body: async ({ signal, partial, steerInput, recordOutput }) => {
        // The brief restarts on its own prompt. What the cut attempt already
        // wrote is still on disk, so it is named rather than re-derived.
        recordCorrection(steerInput);
        const absorb = (): number => {
          const absorbed = absorbBuildCorrections({
            projectDir,
            sessionId,
            state,
            taskId: task.id,
            bus: wctx.bus,
            config,
            modelCache: wctx.modelCache,
          });
          state = absorbed.state;
          setTrackedState(state);
          return absorbed.count;
        };
        const call: ImplementerOptions = {
          task,
          ...(wctx.steering !== undefined && { steering: wctx.steering }),
          projectDir: workspace.projectDir,
          config,
          context,
          languageContext: buildProjectLanguageContext(
            wctx.workspaceDir,
            state.discoveredValidation?.language,
          ),
          plan: state.plan,
          onOutput: (text, opts) => {
            recordOutput(text);
            textHandler(text, opts);
            streamingFeed.onText(text);
          },
          sessionId,
          signal,
          sandboxEnv: workspace.sandboxEnv,
          fileIgnoreProjectDir: projectDir,
          changeDetection: workspace.changeDetection,
          phase: state.phase,
          lineageAttempts: lineageAttemptsOf(state, task),
          approveWrite: async (file) => {
            const decision = await gateChangedFiles({
              changedFiles: [file],
              task,
              dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
              projectDir,
              sessionId,
              phase: state.phase,
              taskId: task.id,
              bus: wctx.bus,
              callbacks,
              config,
            });
            if (decision.cancelled) return { allow: false, reason: decision.reason };
            if (!decision.allow) {
              preApplyApprovalDenied = true;
              const files = decision.changedFiles.join(', ');
              opts.recordApprovalDenial(
                decision,
                `Task changed files blocked by approval gate: ${decision.reason ?? 'denied'} (${files})`,
              );
              return { allow: false, reason: decision.reason ?? 'write denied by approval gate' };
            }
            preApplyApprovedFiles.push(...decision.changedFiles);
            persistApprovalEvidence({ wctx, state, decision, taskId: task.id });
            return { allow: true };
          },
        };
        const creationOwnership = (): Pick<ImplementerOptions, 'createdByThisTask'> => {
          const createdByThisTask = recordedApiCreatedPaths(
            { projectDir, sessionId },
            task,
            workspace.projectDir,
          );
          return createdByThisTask.length > 0 || state.workspace?.kind === 'checkout'
            ? { createdByThisTask }
            : {};
        };
        const produce = async (attemptSignal: AbortSignal): Promise<ImplementerResult> => {
          await settleMidCallDeliveries({ projectDir, sessionId });
          absorb();
          const correction = buildCorrectionInput(state, task, wctx);
          const combinedSteer = correction.continuation?.steer;
          const continues = partial !== undefined || combinedSteer !== undefined;
          const changed = continues
            ? await changedDeclaredFiles(workspace.projectDir, task, opts.taskStartSnapshot)
            : [];
          // A cut attempt continues on the files it wrote before the cut; the call's own row
          // names them, since a call that finds them complete changes nothing of its own.
          const kept = partial !== undefined && changed.length > 0 ? changed : undefined;
          const continuation = continues
            ? {
                ...(partial !== undefined && { partial }),
                ...(combinedSteer !== undefined && { steer: combinedSteer }),
                ...changedDeclaredFilesNote(changed),
                ...(kept !== undefined && { kept }),
              }
            : undefined;
          // A fix task may already have its code on disk when none of its findings needs a change,
          // and a cut attempt may find its kept work complete: either call may change nothing.
          const allowNoChange =
            (task.fix !== undefined && opts.retryError === undefined) || kept !== undefined;
          const firstCall: ImplementerOptions = {
            ...call,
            ...correction,
            signal: attemptSignal,
            ...creationOwnership(),
            ...(continuation !== undefined && { continuation }),
            ...(allowNoChange && { allowNoChange }),
          };
          return runWithCorrectionPasses({
            ref: { projectDir, sessionId },
            first: () =>
              opts.retryError === undefined
                ? wctx.implementer.implement(firstCall)
                : wctx.implementer.retry({
                    ...firstCall,
                    error: opts.retryError,
                    attempt: 1,
                    kind: 'local',
                  }),
            pass: async () => {
              const correction = buildCorrectionInput(state, task, wctx);
              return wctx.implementer.implement({
                ...call,
                ...correction,
                signal: attemptSignal,
                ...creationOwnership(),
                continuation: {
                  ...correction.continuation,
                  ...changedDeclaredFilesNote(
                    await changedDeclaredFiles(workspace.projectDir, task, opts.taskStartSnapshot),
                  ),
                },
                allowNoChange: true,
              });
            },
            absorb,
            signal: attemptSignal,
            onDiscardedUsage: (usage) => {
              state = addUsageAndSave(seatRef, state, 'implementer', usage);
              setTrackedState(state);
            },
            application: {
              wctx,
              state: () => state,
              task,
              workspacePath: workspace.projectDir,
            },
          });
        };

        const seatRef = { projectDir, sessionId, bus: wctx.bus };
        const attempt = await withAttemptRestoreScope({
          ref: wctx,
          dir: workspace.projectDir,
          taskStartSnapshot: opts.taskStartSnapshot,
          attemptSnapshot: workspace.snapshot,
          run: () =>
            runSeatCall(
              {
                ref: seatRef,
                state,
                seat: 'build',
                signal,
                onStateChange: (next) => {
                  state = next;
                  setTrackedState(next);
                },
              },
              async (attemptSignal) =>
                implementerSeatAttempt(
                  await produce(attemptSignal),
                  `Implementer call for ${task.id} failed`,
                ),
              (discarded) => {
                state = addUsageAndSave(seatRef, state, 'implementer', discarded.usage);
                setTrackedState(state);
              },
            ),
        });
        return attempt.value;
      },
    });
  } catch (err) {
    if (isAbortError(err) && isResumableWorkspaceStop(wctx.signal)) await workspace.retain?.();
    else if (!retentionError.isFailed(err)) workspace.cleanup();
    throw err;
  } finally {
    streamingFeed.stop();
  }

  state = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, loop.state);

  // A seat that cannot work parks its brief: the workspace is kept so the
  // continued attempt reads the partial edits it already wrote.
  if (loop.value.outcome === 'usage-limit' || loop.value.outcome === 'unauthenticated') {
    await workspace.retain?.();
  }

  return {
    state,
    implResult: loop.value,
    workspace,
    preApplyApprovalDenied,
    preApplyApprovedFiles,
  };
}
