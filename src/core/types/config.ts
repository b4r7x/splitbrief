export type WorkflowMode = 'quick' | 'standard' | 'full';
export const WORKFLOW_MODES: readonly WorkflowMode[] = ['quick', 'standard', 'full'];

export type ThemeMode = 'terminal' | 'mono';

export type PlannerTool = 'claude-code' | 'codex' | 'opencode' | 'aider' | 'agent-sdk' | 'shell';

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
    type?: 'api' | 'shell' | 'agent';
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
    commitPerTask: boolean;
    mode?: WorkflowMode;
  };
  theme?: ThemeMode;
  shikiTheme?: string;
  sessions?: { scope?: 'project' | 'global' };
}
