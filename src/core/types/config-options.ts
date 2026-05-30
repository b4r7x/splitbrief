import type {
  ApproveLevel,
  EffortLevel,
  PlannerToolId,
  ProviderId,
  WorkflowMode,
} from '../schemas/enums.js';

export interface DetectedModel {
  id: string;
  contextLength?: number;
  pricingInput?: number;
  pricingOutput?: number;
  isFree?: boolean;
  capabilities?: string[];
  releaseDate?: string;
}

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
  approve?: ApproveLevel;
  budget?: number;
  plannerEffort?: EffortLevel;
  allowHooks?: boolean;
  json?: boolean;
  rpc?: boolean;
  otelExporter?: string;
  // When present, start the session in a new linked worktree.
  // Value is the worktree slug (directory name under .trees/).
  // If the flag is passed with no value, the feature argument is slugified.
  worktree?: string;
  detach?: boolean;
  yolo?: boolean;
}

export interface PlannerDetection {
  tool: PlannerToolId;
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
