import type { Config } from '../../core/schemas/config.js';
import type { OrchestratorCallbacks, ResumeContextHolder } from './types.js';
import { emitWarning } from './events.js';
import { buildResumeContext } from './transcript-rebuild.js';

export type ApplyRebuiltContextOpts = {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  config: Pick<Config, 'workflow'>;
  resumeHolder: ResumeContextHolder | undefined;
  requireNonEmpty?: boolean | undefined;
};

export async function applyRebuiltContext(opts: ApplyRebuiltContextOpts): Promise<void> {
  const { projectDir, sessionId, callbacks, config, resumeHolder, requireNonEmpty } = opts;
  const rebuilt = await buildResumeContext(projectDir, sessionId, config.workflow.persistTranscript !== false);
  if (rebuilt.warning === 'transcript-unavailable') {
    emitWarning(callbacks, 'Previous planner conversation expired and no transcript was persisted. Continuing with spec.md/plan.md/tasks.md only — the planner may regenerate differently.');
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
  config: Pick<Config, 'workflow'>;
  resumeHolder: ResumeContextHolder | undefined;
};

export function createSessionExpiredHandler(opts: SessionExpiredHandlerOpts): () => Promise<void> {
  return async () => {
    emitWarning(opts.callbacks, 'Previous planner conversation expired — rebuilding context from transcript.');
    await applyRebuiltContext(opts);
  };
}
