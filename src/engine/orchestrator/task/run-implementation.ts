import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { ImplementerResult } from '../../implementers/types.js';
import type { StagedProject } from '../approval/staged-project.js';
import type { ChangedFilesSnapshot } from '../approval/file-snapshots.js';
import type { GateDecision } from '../approval/tiered-approval.js';
import { createBusTextHandler } from '../events.js';
import { createStreamingFeed, noopStreamingSink } from './streaming-feed.js';
import type { StreamingSink } from './streaming-feed.js';
import { withContinuationLoop } from '../continuation.js';
import { gateChangedFiles } from '../approval/gate-files.js';
import { createStagedProject } from '../approval/staged-project.js';
import { persistApprovalEvidence } from '../evidence/persistence.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';

export type RunImplementationResult = {
  state: WorkflowState;
  implResult: ImplementerResult;
  staged: StagedProject | undefined;
  usesStaging: boolean;
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

  const textHandler = createBusTextHandler({ bus: wctx.bus, phase: state.phase });
  const streamingFeed = createStreamingFeed(task.id, opts.streamingSink ?? noopStreamingSink);

  const usesStaging = wctx.implementer.capabilities?.writesFiles === 'direct';
  const staged = usesStaging ? await createStagedProject(projectDir) : undefined;
  let preApplyApprovalDenied = false;
  let preApplyApprovedFiles: string[] = [];

  let loop: { state: WorkflowState; value: ImplementerResult };
  try {
    loop = await withContinuationLoop<ImplementerResult>({
      ctx: {
        projectDir: staged?.projectDir ?? projectDir,
        sessionId,
        callbacks,
        signal: wctx.signal,
        sinks: wctx.sinks,
      },
      state,
      onStateChange: setTrackedState,
      body: async ({ signal, continuationPrompt, recordOutput }) => {
        const result = await wctx.implementer.implement({
          task,
          projectDir: staged?.projectDir ?? projectDir,
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
          continuationPrompt,
          phase: state.phase,
          approveWrite: async (file) => {
            if (staged) return { allow: true };
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
        });
        return { value: result, continueIfAborted: !result.success };
      },
    });
  } catch (err) {
    streamingFeed.stop();
    staged?.cleanup();
    throw err;
  }

  state = loop.state;
  streamingFeed.stop();

  return {
    state,
    implResult: loop.value,
    staged,
    usesStaging,
    preApplyApprovalDenied,
    preApplyApprovedFiles,
  };
}
