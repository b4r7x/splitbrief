import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { ImplementerOptions, ImplementerResult } from '../../implementers/types.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import { createBusTextHandler } from '../events.js';
import { createStreamingFeed, noopStreamingSink } from './streaming-feed.js';
import type { StreamingSink } from './streaming-feed.js';
import { withContinuationLoop } from '../continuation.js';
import { gateChangedFiles, type GateChangedFilesDenial } from '../approval/gate-files.js';
import { persistApiApplyEvidence, persistApprovalEvidence } from '../evidence/persistence.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { inferTaskAcceptedChangedFiles } from '../changed-files-baseline.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { isAbortError } from '../../../utils/abort.js';
import { implementerSeatAttempt, runSeatCall } from '../escalation/seat-wait.js';
import { addUsageAndSave } from '../state-ops.js';
import { isResumableWorkspaceStop, retentionError } from '../isolation/retention.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';

/**
 * The brief's own declared files that already moved since it started. A restarted
 * attempt is told about them so it edits what is there instead of writing the
 * file again from nothing.
 */
async function changedDeclaredFilesNote(
  projectDir: string,
  task: Task,
  taskStartSnapshot: ChangedFilesSnapshot,
): Promise<{ extra?: string }> {
  try {
    const patterns = taskDeclaredPatterns(task);
    const changed =
      taskStartSnapshot.baselineFileHashes === undefined
        ? await inferTaskAcceptedChangedFiles(projectDir, task, taskStartSnapshot.head)
        : (await getChangedFilesSinceSnapshot(projectDir, taskStartSnapshot)).filter((file) =>
            isInDeclaredSet(file, patterns),
          );
    if (changed.length === 0) return {};
    return {
      extra: `These declared files already differ from the commit this brief started on: ${changed.join(', ')}`,
    };
  } catch {
    // Best-effort context: a snapshot head the operator rewrote must not stop the restart.
    return {};
  }
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

  const textHandler = createBusTextHandler(
    { bus: wctx.bus, phase: state.phase },
    { role: 'implementer' },
  );
  const writesDirectly = wctx.implementer.capabilities?.writesFiles === 'direct';

  let preApplyApprovalDenied = false;
  const preApplyApprovedFiles: string[] = [];

  const step = { kind: 'brief' as const, taskId: task.id, attempt: state.attempt };
  const seed = wctx.continuation?.take(step, hashTaskBrief([task]));
  const workspace: AttemptWorkspace = await wctx.isolation.acquire({
    role: 'implementer',
    config,
    resume: seed?.keepWorkspace === true,
  });
  const createdByThisTask = recordedApiCreatedPaths(
    { projectDir, sessionId },
    task,
    workspace.projectDir,
  );
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
      body: async ({ signal, partial, steer, recordOutput }) => {
        // The brief restarts on its own prompt. What the cut attempt already
        // wrote is still on disk, so it is named rather than re-derived.
        const continuation =
          partial === undefined && steer === undefined
            ? undefined
            : {
                ...(partial !== undefined && { partial }),
                ...(steer !== undefined && { steer }),
                ...(await changedDeclaredFilesNote(
                  workspace.projectDir,
                  task,
                  workspace.snapshot.baselineFileHashes === undefined
                    ? opts.taskStartSnapshot
                    : workspace.snapshot,
                )),
              };
        const call: ImplementerOptions = {
          task,
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
            textHandler(text, { messageStart: writesDirectly && opts?.messageStart === true });
            streamingFeed.onText(text);
          },
          sessionId,
          signal,
          sandboxEnv: workspace.sandboxEnv,
          fileIgnoreProjectDir: projectDir,
          changeDetection: workspace.changeDetection,
          ...(continuation !== undefined && { continuation }),
          ...(createdByThisTask.length > 0 && { createdByThisTask }),
          phase: state.phase,
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
              getApprovalEnabled: wctx.getApprovalEnabled,
            });
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
        const produce = async (attemptSignal: AbortSignal): Promise<ImplementerResult> => {
          // A fix task already has its code on disk when the findings need none; its brief
          // carries the findings, and a no-change attempt completes instead of failing.
          if (task.fix !== undefined && opts.retryError === undefined) {
            return wctx.implementer.implement({
              ...call,
              signal: attemptSignal,
              allowNoChange: true,
            });
          }
          return opts.retryError === undefined
            ? wctx.implementer.implement({ ...call, signal: attemptSignal })
            : wctx.implementer.retry({
                ...call,
                signal: attemptSignal,
                error: opts.retryError,
                attempt: 1,
                kind: 'local',
              });
        };

        const seatRef = { projectDir, sessionId, bus: wctx.bus };
        const attempt = await runSeatCall(
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
        );
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

  state = loop.state;

  // The receipt lands before the caller decides what the attempt was, so a brief
  // that stopped mid-application still names the prefix it already wrote.
  const applyResult = loop.value.applyResult;
  if (applyResult !== undefined) {
    persistApiApplyEvidence({
      wctx,
      state,
      task,
      result: applyResult,
      workspacePath: workspace.projectDir,
    });
  }

  return {
    state,
    implResult: loop.value,
    workspace,
    preApplyApprovalDenied,
    preApplyApprovedFiles,
  };
}
