import type {
  ApproveLevel,
  EffortLevel,
  OutputFormat,
  PlannerToolId,
  ProviderId,
  WorkflowMode,
} from '../schemas/enums.js';

export interface WorkflowOpts {
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
  reviewer?: PlannerToolId;
  reviewerModel?: string;
  reviewerCommand?: string;
  reviewerApiBase?: string;
  reviewerApiKeyEnv?: string;
  reviewerArgs?: string[];
  reviewerOutputFormat?: OutputFormat;
  reviewerContextLength?: number;
  project?: string;
  fullscreen?: boolean;
  mouse?: boolean;
  hover?: boolean;
  mode?: WorkflowMode;
  approve?: ApproveLevel;
  budget?: number;
  plannerEffort?: EffortLevel;
  reviewerEffort?: EffortLevel;
  allowHooks?: boolean;
  allowRepoRunners?: boolean;
  allowUnverifiedAuth?: boolean;
  json?: boolean;
  plain?: boolean;
  yolo?: boolean;
}
