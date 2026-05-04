import type { Config } from '../../core/schemas/config.js';
import type { OrchestratorCallbacks, ResumeContextHolder } from './types.js';
import type { EventBus } from '../events/types.js';
import type { Planner } from '../planners/types.js';
import { publishWarning } from './events.js';
import { buildResumeContext, compactResumeTranscript, keepRecentCountForThreshold } from './transcript-rebuild.js';
import { labelError } from '../../utils/format-errors.js';
import { resolveCompactionFormat } from '../../core/schemas/compaction.js';

export type ApplyRebuiltContextOpts = {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  config: Pick<Config, 'workflow'>;
  resumeHolder: ResumeContextHolder | undefined;
  requireNonEmpty?: boolean | undefined;
};

export type AutoCompactResumeOpts = {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  config: Pick<Config, 'workflow' | 'planner'>;
  planner: Pick<Planner, 'capabilities' | 'summarize' | 'summarizeStructured'>;
};

export async function autoCompactResumeContext(opts: AutoCompactResumeOpts): Promise<void> {
  const threshold = opts.config.workflow.compactionThreshold;
  if (threshold === undefined || opts.config.workflow.persistTranscript === false) return;
  const summarize = opts.planner.summarize;
  if (opts.planner.capabilities.supportsSelfSummarisation !== true || !summarize) return;

  const rebuilt = await buildResumeContext(opts.projectDir, opts.sessionId, true);
  if (rebuilt.messages.length <= threshold) return;

  try {
    const format = resolveCompactionFormat(opts.config.workflow.compactionFormat, opts.config.planner.kind);
    const summarizeStructured = opts.planner.summarizeStructured;
    await compactResumeTranscript(
      opts.projectDir,
      opts.sessionId,
      {
        summarize: messages => summarize(messages, opts.projectDir),
        ...(summarizeStructured
          ? { summarizeStructured: (messages, previous) => summarizeStructured(messages, previous, opts.projectDir) }
          : {}),
      },
      keepRecentCountForThreshold(threshold),
      format,
      () => publishWarning(opts.bus, 'researching', 'Structured compaction returned invalid JSON; saved freeform summary instead.'),
    );
  } catch (err) {
    publishWarning(opts.bus, 'researching', labelError('Transcript auto-compaction failed', err));
  }
}

export async function applyRebuiltContext(opts: ApplyRebuiltContextOpts): Promise<void> {
  const { projectDir, sessionId, bus, config, resumeHolder, requireNonEmpty } = opts;
  const rebuilt = await buildResumeContext(projectDir, sessionId, config.workflow.persistTranscript !== false);
  if (rebuilt.warning === 'transcript-unavailable') {
    publishWarning(bus, 'researching', 'Previous planner conversation expired and no transcript was persisted. Continuing with spec.md/plan.md/tasks.md only — the planner may regenerate differently.');
    return;
  }
  if (!resumeHolder) return;
  if (requireNonEmpty && rebuilt.messages.length === 0) return;
  resumeHolder.messages = rebuilt.messages;
}

export type SessionExpiredHandlerOpts = {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  config: Pick<Config, 'workflow'>;
  resumeHolder: ResumeContextHolder | undefined;
};

export function createSessionExpiredHandler(opts: SessionExpiredHandlerOpts): () => Promise<void> {
  return async () => {
    publishWarning(opts.bus, 'researching', 'Previous planner conversation expired — rebuilding context from transcript.');
    await applyRebuiltContext(opts);
  };
}
