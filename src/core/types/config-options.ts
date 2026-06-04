import type {
  ApproveLevel,
  EffortLevel,
  OutputFormat,
  PlannerToolId,
  ProviderId,
  WorkflowMode,
} from '../schemas/enums.js';

export interface WorkflowOpts {
  auto?: boolean;
  model?: string;
  provider?: ProviderId;
  planner?: PlannerToolId;
  plannerModel?: string;
  plannerCommand?: string;
  plannerApiBase?: string;
  plannerApiKeyEnv?: string;
  plannerArgs?: string[];
  plannerOutputFormat?: OutputFormat;
  plannerContextLength?: number;
  implementer?: ProviderId;
  implementerModel?: string;
  implementerCommand?: string;
  implementerApiBase?: string;
  implementerApiKeyEnv?: string;
  implementerArgs?: string[];
  implementerOutputFormat?: OutputFormat;
  implementerContextLength?: number;
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
