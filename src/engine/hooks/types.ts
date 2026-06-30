export type { HookOutcome } from '../../core/schemas/hooks.js';

export interface HookContext {
  projectDir: string;
  sessionId: string;
  files?: string[];
}
