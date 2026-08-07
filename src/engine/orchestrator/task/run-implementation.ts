import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { ImplementerResult } from '../../implementers/types.js';
import type { IsolatedWorkspace } from '../isolation/types.js';
import type { GateDecision } from '../approval/types.js';
import { createBusTextHandler } from '../events.js';
import { createStreamingFeed, noopStreamingSink } from './streaming-feed.js';
import type { StreamingSink } from './streaming-feed.js';
import { withContinuationLoop } from '../continuation.js';
import { gateChangedFiles } from '../approval/gate-files.js';
import { persistApprovalEvidence } from '../evidence/persistence.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';

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

  const usesIsolation = wctx.implementer.capabilities?.writesFiles === 'direct';
  let workspace: IsolatedWorkspace | undefined;
  let preApplyApprovalDenied = false;
  let preApplyApprovedFiles: string[] = [];

  let loop: { state: WorkflowState; value: ImplementerResult };
  try {
    workspace = usesIsolation
      ? await wctx.isolation.acquire({ role: 'implementer', writesFiles: 'direct', config })
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
      onStateChange: setTrackedState,
      body: ({ signal, continuationPrompt, steer, recordOutput }) =>
        wctx.implementer.implement({
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
          continuationPrompt,
          steer,
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
        }),
    });
  } catch (err) {
    workspace?.cleanup();
    throw err;
  } finally {
    streamingFeed.stop();
  }

  state = loop.state;

  return {
    state,
    implResult: loop.value,
    workspace,
    usesIsolation,
    preApplyApprovalDenied,
    preApplyApprovedFiles,
  };
}
