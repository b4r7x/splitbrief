import type { ProviderId } from '../providers/catalog.js';

export type WorkflowMode = 'quick' | 'standard' | 'full';
export const WORKFLOW_MODES: readonly WorkflowMode[] = ['quick', 'standard', 'full'];

export type CommitStrategy = 'none' | 'checkpoint' | 'per-task';

export type ThemeMode = 'terminal' | 'mono';

/** CLI tool name or API provider used for planning. CLI tools run as subprocesses; providers use the API planner. */
export type PlannerTool = ProviderId;

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
    customModels?: string[];
  };
  implementer: {
    tool: string;
    model: string;
    apiBase: string;
    contextLength: number;
    temperature: number;
    apiKey?: string;
    kind?: 'api' | 'shell' | 'agent' | 'agent-sdk' | 'claude-code' | 'codex' | 'opencode' | 'aider';
    command?: string;
    args?: string[];
    outputFormat?: OutputFormat;
    timeout?: number;
    customModels?: string[];
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

export interface WorkflowOpts {
  auto?: boolean;
  model?: string;
  provider?: string;
  planner?: string;
  plannerModel?: string;
  plannerCommand?: string;
  implementer?: string;
  implementerModel?: string;
  implementerCommand?: string;
  project?: string;
  fullscreen?: boolean;
  mode?: string;
}

export interface PlannerDetection {
  tool: PlannerTool;
  type: 'cli' | 'api' | 'shell';
  available: boolean;
  version?: string | null;
  description?: string;
  error?: string;
}

export interface ProviderDetection {
  provider: string;
  available: boolean;
  models?: string[];
  isLocal: boolean;
  hasKey?: boolean;
}

export const CLI_TOOL_NAMES = ['claude-code', 'codex', 'opencode', 'aider'] as const;
export type ToolName = (typeof CLI_TOOL_NAMES)[number];

export function supportsConversational(tool: PlannerTool): boolean {
  return tool === 'claude-code' || tool === 'agent-sdk';
}
