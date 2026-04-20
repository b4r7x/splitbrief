import type { Config } from '../../core/schemas/config.js';
import type { OrchestratorCallbacks, ResumeContextHolder } from './types.js';
import type { EventBus } from '../events/types.js';
import { publishWarning } from './events.js';
import { buildResumeContext } from './transcript-rebuild.js';

export type ApplyRebuiltContextOpts = {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  config: Pick<Config, 'workflow'>;
  resumeHolder: ResumeContextHolder | undefined;
  requireNonEmpty?: boolean | undefined;
};

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
