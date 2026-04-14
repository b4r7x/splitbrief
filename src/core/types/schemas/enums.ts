import { z } from 'zod';
import { includes } from '../../../utils/type-guards.js';

// Semantic provider groups — CLI tools, API providers, local servers, meta
export const CLI_TOOL_IDS = ['claude-code', 'codex', 'opencode', 'aider', 'copilot', 'kilo-code'] as const;
// API_PROVIDER_IDS: cloud-priced API providers only. agent-sdk is NOT here — it is unpriced (no per-token billing).
export const API_PROVIDER_IDS = ['anthropic', 'openrouter', 'deepseek', 'openai', 'groq', 'together'] as const;
export const LOCAL_PROVIDER_IDS = ['ollama', 'lm-studio'] as const;
// META_PROVIDER_IDS: runners that are neither CLI tools nor priced APIs — shell, agent, agent-sdk.
export const META_PROVIDER_IDS = ['shell', 'agent', 'agent-sdk'] as const;

// Complete list for backward compatibility — must enumerate all values explicitly
// for TypeScript to infer the correct tuple type for z.enum()
export const PROVIDER_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'aider',
  'copilot',
  'kilo-code',
  'agent-sdk',
  'anthropic',
  'openrouter',
  'deepseek',
  'openai',
  'groq',
  'together',
  'ollama',
  'lm-studio',
  'shell',
  'agent',
] as const;

// Planner-only tools: CLI tools + API providers + shell + agent. Excludes local-only providers (ollama, lm-studio).
export const PLANNER_TOOL_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'aider',
  'copilot',
  'kilo-code',
  'agent-sdk',
  'anthropic',
  'openrouter',
  'deepseek',
  'openai',
  'groq',
  'together',
  'shell',
  'agent',
] as const;

export type CliToolId = (typeof CLI_TOOL_IDS)[number];
export type ApiProviderId = (typeof API_PROVIDER_IDS)[number];
export type LocalProviderId = (typeof LOCAL_PROVIDER_IDS)[number];
export type MetaProviderId = (typeof META_PROVIDER_IDS)[number];
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type PlannerToolId = (typeof PLANNER_TOOL_IDS)[number];

export function isProviderId(id: string): id is ProviderId {
  return includes(PROVIDER_IDS, id);
}

export function isPlannerToolId(id: string): id is PlannerToolId {
  return includes(PLANNER_TOOL_IDS, id);
}

export const PHASES = ['idle', 'researching', 'specifying', 'reviewing-spec', 'planning', 'reviewing-plan', 'implementing', 'validating-task', 'escalating', 'final-review', 'complete'] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

export const TASK_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'escalated', 'skipped'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TASK_COMPLETION_METHODS = ['local', 'escalated-intermediate', 'escalated-hint', 'escalated-full', 'failed', 'skipped'] as const;
export const TaskCompletionMethodSchema = z.enum(TASK_COMPLETION_METHODS);
export type TaskCompletionMethod = z.infer<typeof TaskCompletionMethodSchema>;

export const WORKFLOW_MODES = ['quick', 'standard', 'full'] as const;
export const WorkflowModeSchema = z.enum(WORKFLOW_MODES);
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

export const COMMIT_STRATEGIES = ['none', 'checkpoint', 'per-task'] as const;
export const CommitStrategySchema = z.enum(COMMIT_STRATEGIES);
export type CommitStrategy = z.infer<typeof CommitStrategySchema>;

export const THEME_MODES = ['terminal', 'mono'] as const;
export const ThemeModeSchema = z.enum(THEME_MODES);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

export const SHIKI_THEMES = ['github-dark', 'github-light'] as const;
export const ShikiThemeSchema = z.enum(SHIKI_THEMES);
export type ShikiTheme = z.infer<typeof ShikiThemeSchema>;

export const OUTPUT_FORMATS = ['stream-json', 'jsonl', 'text', 'opencode'] as const;
export const OutputFormatSchema = z.enum(OUTPUT_FORMATS);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const CliToolIdSchema = z.enum(CLI_TOOL_IDS);
export const CliPlannerToolSchema = CliToolIdSchema;
export type CliPlannerTool = z.infer<typeof CliPlannerToolSchema>;

// Runner kind discriminant values
export const RUNNER_KINDS = ['cli', 'api', 'shell', 'agent', 'agent-sdk'] as const;
export const RunnerKindSchema = z.enum(RUNNER_KINDS);
export type RunnerKind = z.infer<typeof RunnerKindSchema>;

// API provider categories
export const KNOWN_API_PROVIDERS = [...LOCAL_PROVIDER_IDS, ...API_PROVIDER_IDS] as const;

