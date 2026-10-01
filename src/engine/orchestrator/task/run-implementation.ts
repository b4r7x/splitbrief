import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
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
import {
  persistApiApplyEvidence,
  persistApprovalEvidence,
  invalidateTargetWriteEvidence,
} from '../evidence/persistence.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { inferTaskAcceptedChangedFiles } from '../changed-files-baseline.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { isAbortError } from '../../../utils/abort.js';
import {
  isResumableWorkspaceStop,
  retentionError,
  workspaceOwner,
} from '../isolation/retention.js';
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
  workspace: IsolatedWorkspace | undefined;
  preApplyApprovalDenied: boolean;
  preApplyApprovedFiles: string[];
};

// A finding about evidence or run files names files outside the worktree that
// only SPLITBRIEF and the review seat produce; chasing them trips isolation.
const REVIEW_FIX_INSTRUCTION = [
  "These findings come from the final review. Change code only where a finding names a defect in the code or tests inside this brief's files.",
  "Findings about evidence, renders, validation runs or run files (evidence.json, the session folder) are SPLITBRIEF's and the review seat's job: do not search for those files, and do not leave this directory.",
  'If no finding needs a code change, change nothing and report that. SPLITBRIEF validates the unchanged brief.',
].join('\n');

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
  const usesIsolation = wctx.implementer.capabilities?.writesFiles === 'direct';
  // A direct writer narrates between tool calls; that text has one home, the transcript rows
  // textHandler feeds. The preview under `working on <file>…` is for the code an extractor
  // streams: it splits lines, not messages, so narration there would repeat and run together.
  const streamingFeed = createStreamingFeed(
    task.id,
    usesIsolation ? noopStreamingSink : (opts.streamingSink ?? noopStreamingSink),
  );

  // A brief reopened by the final review already has code on disk; the fix
  // attempt is framed as a retry carrying the reviewer's findings as the error,
  // and a finding that needs no code change lets it verify and change nothing.
  const reviewFindings = state.reviewFixes?.findings[task.id];

  let workspace: IsolatedWorkspace | undefined;
  let preApplyApprovalDenied = false;
  let preApplyApprovedFiles: string[] = [];

  const step = { kind: 'brief' as const, taskId: task.id, attempt: state.attempt };
  const seed = wctx.continuation?.take(step, hashTaskBrief([task]));
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
          fresh: seed?.keepWorkspace !== true,
          owner: workspaceOwner({ task, attempt: state.attempt, config }),
          resume: seed?.keepWorkspace === true,
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
        if (workspace === undefined || workspace.projectDir === projectDir) {
          invalidateTargetWriteEvidence({ ref: { projectDir, sessionId }, task });
        }
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
                  workspace?.snapshot.baselineFileHashes === undefined
                    ? opts.taskStartSnapshot
                    : workspace.snapshot,
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
          onOutput: (text, opts) => {
            recordOutput(text);
            textHandler(text, { messageStart: usesIsolation && opts?.messageStart === true });
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
              error: [REVIEW_FIX_INSTRUCTION, ...reviewFindings].join('\n'),
              attempt: 1,
              kind: 'local',
              allowNoChange: true,
            });
      },
    });
  } catch (err) {
    if (isAbortError(err) && isResumableWorkspaceStop(wctx.signal)) await workspace?.retain?.();
    else if (!retentionError.isFailed(err)) workspace?.cleanup();
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
    preApplyApprovalDenied,
    preApplyApprovedFiles,
  };
}
