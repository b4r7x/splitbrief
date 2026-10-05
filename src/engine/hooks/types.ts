export type { HookOutcome } from '../../core/schemas/hooks.js';

export interface HookContext {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  files?: string[];
}
