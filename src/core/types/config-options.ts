import type { ApproveLevel, EffortLevel, PlannerToolId, ProviderId, WorkflowMode } from '../schemas/enums.js';

export interface DetectedModel {
  id: string;
  contextLength?: number;
  pricingInput?: number;
  pricingOutput?: number;
  isFree?: boolean;
  capabilities?: string[];
  releaseDate?: string;
}

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
  approve?: ApproveLevel;
  budget?: number;
  plannerEffort?: EffortLevel;
  allowHooks?: boolean;
  json?: boolean;
  otelExporter?: string;
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
