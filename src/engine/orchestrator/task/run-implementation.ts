import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { WorkflowContext } from '../types.js';
import type { ImplementerResult } from '../../implementers/types.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import { createImplementerTextHandler } from '../publish/runner.js';
import { createStreamingFeed, noopStreamingSink } from './streaming-feed.js';
import type { StreamingSink } from './streaming-feed.js';
import type { GateChangedFilesDenial } from '../approval/gate-files.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { settleThrownCall } from '../isolation/retention.js';
import { recordCorrection, runImplementerLoop } from './implementer-loop.js';
import type { ImplementerLoopState } from './types.js';

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
}): Promise<RunImplementationResult> {
  const { wctx, task } = opts;
  const { projectDir, sessionId, config } = wctx;

  const textHandler = createImplementerTextHandler(
    { bus: wctx.bus, phase: opts.state.phase },
    wctx.implementer,
  );
  const writesDirectly = wctx.implementer.capabilities?.writesFiles === 'direct';

  const step = { kind: 'brief' as const, taskId: task.id, attempt: opts.state.attempt };
  const seed = wctx.continuation?.take(step, hashTaskBrief([task]));
  const shared: ImplementerLoopState = {
    state: rebaseOnPersistedWorkflowState({ projectDir, sessionId }, opts.state),
    recordedCorrection: undefined,
    preApplyApprovalDenied: false,
    preApplyApprovedFiles: [],
  };
  recordCorrection(opts, shared, seed?.steer);
  const workspace: AttemptWorkspace = await wctx.isolation.acquire({
    role: 'implementer',
    config,
    resume: seed?.keepWorkspace === true,
    brief: { task, taskStartSnapshot: opts.taskStartSnapshot },
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
    loop = await runImplementerLoop(
      {
        wctx,
        task,
        taskStartSnapshot: opts.taskStartSnapshot,
        setTrackedState: opts.setTrackedState,
        recordApprovalDenial: opts.recordApprovalDenial,
        textHandler,
        workspace,
        streamingFeed,
        step,
        seed,
      },
      shared,
    );
  } catch (err) {
    await settleThrownCall(workspace, wctx.signal, err);
    throw err;
  } finally {
    streamingFeed.stop();
  }

  const state = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, loop.state);

  // A seat that cannot work parks its brief: the workspace is kept so the
  // continued attempt reads the partial edits it already wrote.
  if (loop.value.outcome === 'usage-limit' || loop.value.outcome === 'unauthenticated') {
    await workspace.retain?.();
  }

  return {
    state,
    implResult: loop.value,
    workspace,
    preApplyApprovalDenied: shared.preApplyApprovalDenied,
    preApplyApprovedFiles: shared.preApplyApprovedFiles,
  };
}
