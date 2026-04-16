import type { PlannerToolId, ProviderId } from './schemas/enums.js';
export type { PlannerConfig, ImplementerConfig, Config } from './schemas/config.js';
export { DEFAULT_WORKFLOW_MODE } from './schemas/config.js';

export interface DetectedModel {
  id: string;
  contextLength?: number;
  pricingInput?: number;
  pricingOutput?: number;
  isFree?: boolean;
  capabilities?: string[];
  releaseDate?: string;
}

export type {
  WorkflowMode, CommitStrategy, ThemeMode, ShikiTheme,
  OutputFormat, CliPlannerTool, RunnerKind,
} from './schemas/enums.js';
export {
  WORKFLOW_MODES, COMMIT_STRATEGIES, THEME_MODES, SHIKI_THEMES,
  OUTPUT_FORMATS, RUNNER_KINDS, RunnerKindSchema,
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
  mouse?: boolean | undefined;
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
  models?: DetectedModel[] | undefined;
  isLocal: boolean;
  hasKey?: boolean | undefined;
}
