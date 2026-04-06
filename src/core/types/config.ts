export type WorkflowMode = 'quick' | 'standard' | 'full';
export const WORKFLOW_MODES: readonly WorkflowMode[] = ['quick', 'standard', 'full'];

export type CommitStrategy = 'none' | 'checkpoint' | 'per-task';
export const COMMIT_STRATEGIES: readonly CommitStrategy[] = ['none', 'checkpoint', 'per-task'];

export type ThemeMode = 'terminal' | 'mono';

export type PlannerTool = 'claude-code' | 'codex' | 'opencode' | 'aider' | 'agent-sdk' | 'shell' | 'anthropic' | 'openrouter';

export type OutputFormat = 'stream-json' | 'jsonl' | 'text' | 'opencode';

export interface Config {
  planner: {
    tool: PlannerTool;
    provider?: string;
    model?: string;
    apiKey?: string;
    apiBase?: string;
    command?: string;
    args?: string[];
    outputFormat?: OutputFormat;
  };
  implementer: {
    provider: string;
    model: string;
    apiBase: string;
    contextLength: number;
    temperature: number;
    apiKey?: string;
    type?: 'api' | 'shell' | 'agent' | 'claude-code' | 'codex' | 'opencode' | 'aider';
    command?: string;
    args?: string[];
    outputFormat?: OutputFormat;
    timeout?: number;
  };
  validation: {
    typecheck: boolean;
    lint: boolean;
    test: boolean;
    testCommand: string;
  };
  workflow: {
    autoApproveSpec: boolean;
    autoApprovePlan: boolean;
    maxRetries: number;
    commitStrategy: CommitStrategy;
    mode?: WorkflowMode;
  };
  theme?: ThemeMode;
  shikiTheme?: string;
  sessions?: { scope?: 'project' | 'global' };
}
