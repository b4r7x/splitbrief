export type HookOutcome =
  | { kind: 'allow' }
  | { kind: 'deny'; message?: string }
  | { kind: 'warn'; message?: string }
  | { kind: 'crash'; message: string };

export interface HookContext {
  projectDir: string;
  sessionId: string;
  files?: string[];
}
