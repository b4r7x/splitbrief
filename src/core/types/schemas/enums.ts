import { z } from 'zod';
import { PROVIDER_IDS } from '../../providers/catalog.js';

export const PHASES = ['idle', 'researching', 'specifying', 'reviewing-spec', 'planning', 'reviewing-plan', 'implementing', 'validating-task', 'escalating', 'final-review', 'complete'] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

export const TASK_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'escalated', 'skipped'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TASK_COMPLETION_METHODS = ['local', 'escalated-hint', 'escalated-full', 'failed', 'skipped'] as const;
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

export const PLANNER_KINDS = ['cli', 'agent-sdk', 'api', 'shell'] as const;
export const PlannerKindSchema = z.enum(PLANNER_KINDS);
export type PlannerKind = z.infer<typeof PlannerKindSchema>;

export const IMPLEMENTER_KINDS = ['api', 'shell', 'agent', 'agent-sdk', 'claude-code', 'codex', 'opencode', 'aider'] as const;
export const ImplementerKindSchema = z.enum(IMPLEMENTER_KINDS);
export type ImplementerKind = z.infer<typeof ImplementerKindSchema>;

export const CLI_TOOL_NAMES = ['claude-code', 'codex', 'opencode', 'aider'] as const;
export const CliPlannerToolSchema = z.enum(CLI_TOOL_NAMES);
export type CliPlannerTool = z.infer<typeof CliPlannerToolSchema>;

export const ProviderIdSchema = z.enum(PROVIDER_IDS);
