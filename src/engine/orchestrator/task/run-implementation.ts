import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { ImplementerOptions, ImplementerResult } from '../../implementers/types.js';
import type { IsolatedWorkspace } from '../isolation/types.js';
import type { GateDecision } from '../approval/types.js';
import { createBusTextHandler } from '../events.js';
import { createStreamingFeed, noopStreamingSink } from './streaming-feed.js';
import type { StreamingSink } from './streaming-feed.js';
import { withContinuationLoop } from '../continuation.js';
import { gateChangedFiles } from '../approval/gate-files.js';
import { persistApiApplyEvidence, persistApprovalEvidence } from '../evidence/persistence.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { inferTaskAcceptedChangedFiles } from '../changed-files-baseline.js';
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
    const changed = await inferTaskAcceptedChangedFiles(projectDir, task, taskStartSnapshot.head);
    if (changed.length === 0) return {};
    return {
      extra: `These declared files already changed since the task started: ${changed.join(', ')}`,
    };
  } catch {
    // Best-effort context: a snapshot head the operator rewrote must not stop the restart.
    return {};
  }
}

export type RunImplementationResult = {
  state: WorkflowState;
  implResult: ImplementerResult;
  workspace: IsolatedWorkspace | undefined;
  usesIsolation: boolean;
  preApplyApprovalDenied: boolean;
  preApplyApprovedFiles: string[];
};

export async function runImplementation(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  taskStartSnapshot: ChangedFilesSnapshot;
  setTrackedState: (s: WorkflowState) => void;
  recordApprovalDenial: (decision: GateDecision, message: string) => void;
  streamingSink?: StreamingSink | undefined;
}): Promise<RunImplementationResult> {
  const { wctx, task, setTrackedState } = opts;
  const { projectDir, sessionId, config, callbacks, context } = wctx;
  let state = opts.state;

  const textHandler = createBusTextHandler(
    { bus: wctx.bus, phase: state.phase },
    { role: 'implementer' },
  );
  const streamingFeed = createStreamingFeed(task.id, opts.streamingSink ?? noopStreamingSink);

  // A brief reopened by the final review already has code on disk; the fix
  // attempt is framed as a retry carrying the reviewer's findings as the error.
  const reviewFindings = state.reviewFixes?.findings[task.id];

  const usesIsolation = wctx.implementer.capabilities?.writesFiles === 'direct';
  let workspace: IsolatedWorkspace | undefined;
  let preApplyApprovalDenied = false;
  let preApplyApprovedFiles: string[] = [];

  const step = { kind: 'brief' as const, taskId: task.id, attempt: state.attempt };
  const seed = wctx.continuation?.take(step);
  const createdByThisTask = recordedApiCreatedPaths({ projectDir, sessionId }, task);

  let loop: { state: WorkflowState; value: ImplementerResult };
  try {
    // Only a mid-step partial resumes an earlier attempt's worktree. A steer
    // alone is guidance for a fresh try, so it must not keep leftovers a failed
    // promotion or a restore already reverted in the project — reseed instead.
    workspace = usesIsolation
      ? await wctx.isolation.acquire({
          role: 'implementer',
          writesFiles: 'direct',
          config,
          fresh: state.attempt === 0 && seed?.partial === undefined,
        })
      : undefined;
    loop = await withContinuationLoop<ImplementerResult>({
      ctx: {
        projectDir: workspace?.projectDir ?? projectDir,
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
                  workspace?.projectDir ?? projectDir,
                  task,
                  opts.taskStartSnapshot,
                )),
              };
        const call: ImplementerOptions = {
          task,
          projectDir: workspace?.projectDir ?? projectDir,
          config,
          context,
          languageContext: buildProjectLanguageContext(
            projectDir,
            state.discoveredValidation?.language,
          ),
          onOutput: (text) => {
            recordOutput(text);
            textHandler(text);
            streamingFeed.onText(text);
          },
          sessionId,
          signal,
          sandboxEnv: workspace?.sandboxEnv,
          fileIgnoreProjectDir: workspace ? projectDir : undefined,
          changeDetection: workspace?.changeDetection,
          ...(continuation !== undefined && { continuation }),
          ...(createdByThisTask.length > 0 && { createdByThisTask }),
          phase: state.phase,
          approveWrite: async (file) => {
            if (workspace) return { allow: true };
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
            preApplyApprovedFiles = decision.changedFiles;
            persistApprovalEvidence({ wctx, state, decision, taskId: task.id });
            return { allow: true };
          },
        };
        return reviewFindings === undefined
          ? wctx.implementer.implement(call)
          : wctx.implementer.retry({
              ...call,
              error: reviewFindings.join('\n'),
              attempt: 1,
              kind: 'local',
            });
      },
    });
  } catch (err) {
    workspace?.cleanup();
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
      ...(workspace === undefined ? {} : { workspacePath: workspace.projectDir }),
    });
  }

  return {
    state,
    implResult: loop.value,
    workspace,
    usesIsolation,
    preApplyApprovalDenied,
    preApplyApprovedFiles,
  };
}
