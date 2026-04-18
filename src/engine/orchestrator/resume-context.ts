import type { Config } from '../../core/types/config-options.js';
import type { OrchestratorCallbacks, ResumeContextHolder } from './types.js';
import { emitWarning } from './events.js';
import { buildResumeContext } from './transcript-rebuild.js';

export type ApplyRebuiltContextOpts = {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  config: Pick<Config, 'workflow'>;
  resumeHolder: ResumeContextHolder | undefined;
  /** Whether to only populate resumeHolder when rebuilt.messages is non-empty (initial bootstrap). */
  requireNonEmpty?: boolean | undefined;
};

/**
 * Rebuild transcript context from disk and either populate the shared resumeHolder with prior
 * messages or emit a fallback warning when no transcript is persisted. Shared between the
 * mid-run `onSessionExpired` handler and the initial-bootstrap flow in run.ts.
 */
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

/**
 * Returns an async handler to pass as `onSessionExpired` to a planner call. The handler emits
 * a "rebuilding" warning, rebuilds the transcript context from disk, and populates the shared
 * resumeHolder so the next planner invocation re-injects prior messages. When no transcript is
 * persisted, emits a fallback warning instead.
 */
export function createSessionExpiredHandler(opts: SessionExpiredHandlerOpts): () => Promise<void> {
  return async () => {
    emitWarning(opts.callbacks, 'Previous planner conversation expired — rebuilding context from transcript.');
    await applyRebuiltContext(opts);
  };
}
