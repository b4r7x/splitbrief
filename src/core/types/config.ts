import type { PlannerToolId, ProviderId, WorkflowMode } from './schemas/enums.js';
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
  auto?: boolean;
  model?: string;
  provider?: ProviderId;
  planner?: PlannerToolId;
  plannerModel?: string;
  plannerCommand?: string;
  implementer?: ProviderId;
  implementerModel?: string;
  implementerCommand?: string;
  project?: string;
  fullscreen?: boolean;
  mouse?: boolean;
  mode?: WorkflowMode;
  budget?: number;
}

export interface PlannerDetection {
  tool: PlannerTool;
  // agent-sdk excluded: it's programmatic (not detectable via CLI probe).
  type: 'cli' | 'api' | 'shell';
  available: boolean;
  version?: string;
  description?: string;
  error?: string;
}

export interface ProviderDetection {
  provider: ProviderId;
  available: boolean;
  models?: DetectedModel[];
  isLocal: boolean;
  hasKey?: boolean;
  error?: string;
}
