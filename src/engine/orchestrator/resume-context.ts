import type { Config } from '../../core/schemas/config.js';
import type { ResumeContextHolder } from './types.js';
import type { EventBus } from '../events/types.js';
import type { Planner, PriorMessage } from '../planners/types.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { isSessionExpiredError } from '../session-expiry.js';
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
        publishRunnerCallEvent(
          { bus: opts.bus, phase: opts.state.phase, rootDir: opts.projectDir },
          event,
        ),
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

/**
 * Issues one planning call: a step's or a revision's. A call that resumed the planner's thread and
 * finds it expired runs once more, on a fresh session with the rebuilt transcript, as a continued
 * run would: the seat has already dropped the thread. Any other failure, and a failure of the call
 * issued again, is the caller's.
 */
export async function withExpiredSessionReissue<T>(opts: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  planner: Pick<Planner, 'capabilities'>;
  /** The state the call starts on: the thread it names is the one the call resumes. */
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  issue: (priorMessages?: PriorMessage[]) => Promise<T>;
}): Promise<T> {
  const { projectDir, sessionId, bus, state, signal } = opts;
  const resumed =
    opts.planner.capabilities.supportsSessionResume && Boolean(state.plannerSessionId);
  try {
    return await opts.issue();
  } catch (err) {
    if (!resumed || signal?.aborted || !isSessionExpiredError(err)) throw err;
    publishWarning({
      bus,
      phase: state.phase,
      message:
        'Planner session expired; the call runs again on a fresh session with the conversation so far.',
      safety: { category: 'planner', code: 'planner_session_expired' },
    });
    const rebuilt: ResumeContextHolder = { messages: [] };
    await applyRebuiltContext({
      projectDir,
      sessionId,
      bus,
      resumeHolder: rebuilt,
    });
    return opts.issue(rebuilt.messages);
  }
}
