import type { PlannerToolId, ProviderId } from './schemas/enums.js';
import type { z } from 'zod';
import type { PlannerConfigSchema, ImplementerConfigSchema, ConfigSchema } from './schemas/config.js';
import {
  CLI_TOOL_NAMES,
  type CliPlannerTool,
} from './schemas/enums.js';

export type {
  WorkflowMode, CommitStrategy, ThemeMode, ShikiTheme,
  OutputFormat, CliPlannerTool, RunnerKind,
} from './schemas/enums.js';
export {
  WORKFLOW_MODES, COMMIT_STRATEGIES, THEME_MODES, SHIKI_THEMES,
  OUTPUT_FORMATS, CLI_TOOL_NAMES, RUNNER_KINDS, RunnerKindSchema,
} from './schemas/enums.js';

export type {
  CliImplementerConfig,
  ApiImplementerConfig,
  ShellImplementerConfig,
  AgentImplementerConfig,
  AgentSdkImplementerConfig,
} from './schemas/implementer-config.js';
export type {
  CliPlannerConfig,
  ApiPlannerConfig,
  ShellPlannerConfig,
  AgentPlannerConfig,
  AgentSdkPlannerConfig,
} from './schemas/planner-config.js';

export type PlannerTool = PlannerToolId;

export function isCliTool(tool: string): tool is CliPlannerTool {
  return (CLI_TOOL_NAMES as readonly string[]).includes(tool);
}

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

export type ImplementerConfig = z.infer<typeof ImplementerConfigSchema>;

export type Config = z.infer<typeof ConfigSchema>;

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
  budget?: number | undefined;
}

export interface PlannerDetection {
  tool: PlannerTool;
  // agent-sdk excluded: it's programmatic (not detectable via CLI probe).
  type: 'cli' | 'api' | 'shell';
  available: boolean;
  version?: string | undefined;
  description?: string | undefined;
  error?: string | undefined;
}

export interface ProviderDetection {
  provider: ProviderId;
  available: boolean;
  models?: string[] | undefined;
  isLocal: boolean;
  hasKey?: boolean | undefined;
}
