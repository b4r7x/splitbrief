import type { ProviderId } from '../providers/catalog.js';

export type WorkflowMode = 'quick' | 'standard' | 'full';
export const WORKFLOW_MODES: readonly WorkflowMode[] = ['quick', 'standard', 'full'];

export type CommitStrategy = 'none' | 'checkpoint' | 'per-task';

export type ThemeMode = 'terminal' | 'mono';

/** CLI tool name or API provider used for planning. CLI tools run as subprocesses; providers use the API planner. */
export type PlannerTool = ProviderId;

export type OutputFormat = 'stream-json' | 'jsonl' | 'text' | 'opencode';

export const IMPLEMENTER_KINDS = ['api', 'shell', 'agent', 'agent-sdk', 'claude-code', 'codex', 'opencode', 'aider'] as const;
export type ImplementerKind = typeof IMPLEMENTER_KINDS[number];

export interface Config {
  planner: {
    tool: PlannerTool;
    provider?: string | undefined;
    model?: string | undefined;
    apiKey?: string | undefined;
    apiBase?: string | undefined;
    command?: string | undefined;
    args?: string[] | undefined;
    outputFormat?: OutputFormat | undefined;
    customModels?: string[] | undefined;
  };
  implementer: {
    tool: string;
    model: string;
    apiBase: string;
    contextLength: number;
    temperature: number;
    apiKey?: string | undefined;
    kind?: ImplementerKind | undefined;
    command?: string | undefined;
    args?: string[] | undefined;
    outputFormat?: OutputFormat | undefined;
    timeout?: number | undefined;
    customModels?: string[] | undefined;
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
    mode?: WorkflowMode | undefined;
  };
  theme?: ThemeMode | undefined;
  shikiTheme?: string | undefined;
  sessions?: { scope?: 'project' | 'global' | undefined } | undefined;
}

export interface WorkflowOpts {
  auto?: boolean | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  planner?: string | undefined;
  plannerModel?: string | undefined;
  plannerCommand?: string | undefined;
  implementer?: string | undefined;
  implementerModel?: string | undefined;
  implementerCommand?: string | undefined;
  project?: string | undefined;
  fullscreen?: boolean | undefined;
  mode?: string | undefined;
}

export interface PlannerDetection {
  tool: PlannerTool;
  type: 'cli' | 'api' | 'shell';
  available: boolean;
  version?: string | null | undefined;
  description?: string | undefined;
  error?: string | undefined;
}

export interface ProviderDetection {
  provider: string;
  available: boolean;
  models?: string[] | undefined;
  isLocal: boolean;
  hasKey?: boolean | undefined;
}

export const CLI_TOOL_NAMES = ['claude-code', 'codex', 'opencode', 'aider'] as const;
export type ToolName = (typeof CLI_TOOL_NAMES)[number];

export function supportsConversational(tool: PlannerTool): boolean {
  return tool === 'claude-code' || tool === 'agent-sdk';
}
