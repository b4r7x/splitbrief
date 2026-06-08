export type HookOutcome =
  | { kind: 'allow'; stderr?: string }
  | { kind: 'deny'; message?: string; stderr?: string }
  | { kind: 'warn'; message?: string; stderr?: string }
  | { kind: 'crash'; message: string; stderr?: string };

export interface HookContext {
  projectDir: string;
  sessionId: string;
  files?: string[];
}
