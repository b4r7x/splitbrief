import type { Config } from '../../core/schemas/config.js';
import type { ResumeContextHolder } from './types.js';
import type { EventBus } from '../events/types.js';
import type { Planner } from '../planners/types.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { publishWarning, publishWarningFromError } from './events.js';
import { buildResumeContext } from './transcript/rebuild.js';
import { compactResumeTranscript, keepRecentCountForThreshold } from './transcript/compaction.js';
import { addUsageAndSave } from './state-ops.js';
import { resolveCompactionFormat } from '../../core/schemas/compaction.js';
import { publishRunnerCallEvent } from './events.js';
import { isAbortError } from '../../utils/abort.js';

export type ApplyRebuiltContextOpts = {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  resumeHolder: ResumeContextHolder | undefined;
  requireNonEmpty?: boolean | undefined;
};

export type AutoCompactResumeOpts = {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  config: Pick<Config, 'workflow' | 'planner'>;
  planner: Pick<Planner, 'capabilities' | 'summarize' | 'summarizeStructured'>;
  state: WorkflowState;
  signal?: AbortSignal | undefined;
};

export async function autoCompactResumeContext(
  opts: AutoCompactResumeOpts,
): Promise<WorkflowState> {
  const threshold = opts.config.workflow.compactionThreshold;
  if (threshold === undefined) return opts.state;
  const summarize = opts.planner.summarize;
  if (opts.planner.capabilities.supportsSelfSummarisation !== true || !summarize) return opts.state;

  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const rebuilt = await buildResumeContext({ ref });
  if (rebuilt.messages.length <= threshold) return opts.state;

  try {
    const format = resolveCompactionFormat(
      opts.config.workflow.compactionFormat,
      opts.config.planner.kind,
    );
    const result = await compactResumeTranscript({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      planner: opts.planner,
      keepRecentCount: keepRecentCountForThreshold(threshold),
      format,
      ...(opts.signal !== undefined && { signal: opts.signal }),
      onCallEvent: (event) =>
        publishRunnerCallEvent({ bus: opts.bus, phase: opts.state.phase }, event),
      onFallback: () =>
        publishWarning({
          bus: opts.bus,
          phase: 'researching',
          message: 'Structured compaction returned invalid JSON; saved freeform summary instead.',
        }),
    });
    return addUsageAndSave(
      { projectDir: opts.projectDir, sessionId: opts.sessionId, bus: opts.bus },
      opts.state,
      'planner',
      result.usage,
    );
  } catch (err) {
    if (opts.signal?.aborted || isAbortError(err)) return opts.state;
    publishWarningFromError(
      { bus: opts.bus, phase: 'researching' },
      'Transcript auto-compaction failed',
      err,
    );
    return opts.state;
  }
}

export async function applyRebuiltContext(opts: ApplyRebuiltContextOpts): Promise<void> {
  const { projectDir, sessionId, bus, resumeHolder, requireNonEmpty } = opts;
  const rebuilt = await buildResumeContext({ ref: { projectDir, sessionId } });
  if (rebuilt.warning === 'state-unavailable') {
    publishWarning({
      bus,
      phase: 'researching',
      message:
        'Saved workflow state was unavailable, so pending queued messages were not replayed into planner context.',
    });
    return;
  }
  if (!resumeHolder) return;
  if (requireNonEmpty && rebuilt.messages.length === 0) return;
  resumeHolder.messages = rebuilt.messages;
}

export type SessionExpiredHandlerOpts = {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  resumeHolder: ResumeContextHolder | undefined;
};

export function createSessionExpiredHandler(opts: SessionExpiredHandlerOpts): () => Promise<void> {
  return async () => {
    publishWarning({
      bus: opts.bus,
      phase: 'researching',
      message: 'Previous planner conversation expired — rebuilding context from transcript.',
    });
    await applyRebuiltContext(opts);
  };
}
