import type { EngineEvent, EngineEventOf } from '../events/types.js';

/** What a hook reads as `event`: an engine event, or the pre_validation gate's payload, which names only the brief. */
export type HookPayload = EngineEvent | Omit<EngineEventOf<'validate'>, 'stages'>;

export type { HookOutcome } from '../../core/schemas/hooks.js';

export interface HookContext {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  files?: string[];
}
