import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import type {
  ImplementerCostTier,
  ImplementerWriteMode,
} from '../../../core/schemas/implementer-config.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { LanguageContext } from '../../spec/prompts/language-context.js';
import type { TaskContextFit, CurrentCodeContextMode } from '../../../core/schemas/enums.js';

export interface TaskPromptEstimateOptions {
  task: Task;
  context: ProjectContext;
  contextLength?: number | undefined;
  languageContext?: LanguageContext | undefined;
}

export interface ContextFitOptions {
  safetyMargin?: number | undefined;
  tightThreshold?: number | undefined;
}

export interface RouteTaskOptions extends ContextFitOptions {
  task: Task;
  context: ProjectContext;
  profiles: ResolvedImplementerProfile[];
  conservativeContextLength?: number | undefined;
  contextCache?: ModelCacheAccessor | undefined;
  languageContext?: LanguageContext | undefined;
  detectedContextLength?: number | undefined;
}

export interface RejectedImplementerProfile {
  profile: string;
  costTier: ImplementerCostTier;
  profileWriteMode: ImplementerWriteMode;
  requiredWriteMode: ImplementerWriteMode;
  reason: string;
  fit: TaskContextFit;
  estimatedTokens: number;
  untruncatedEstimatedTokens: number;
  contextLength: number;
  currentCodeTruncated: boolean;
  currentCodeContextMode: CurrentCodeContextMode;
}

export interface RoutingDecision {
  taskId: TaskId;
  selectedProfile?: string | undefined;
  selectedCostTier?: ImplementerCostTier | undefined;
  selectedWriteMode?: ImplementerWriteMode | undefined;
  requiredWriteMode: ImplementerWriteMode;
  fit: TaskContextFit;
  estimatedTokens: number;
  untruncatedEstimatedTokens: number;
  contextLength?: number | undefined;
  currentCodeTruncated: boolean;
  currentCodeContextMode: CurrentCodeContextMode;
  costPosture: string;
  reason: string;
  rejected: RejectedImplementerProfile[];
}

export interface ProfileFit {
  profile: ResolvedImplementerProfile;
  fit: TaskContextFit;
  estimatedTokens: number;
  untruncatedEstimatedTokens: number;
  contextLength: number;
  currentCodeTruncated: boolean;
  currentCodeContextMode: CurrentCodeContextMode;
  usedConservativeContextLength: boolean;
  requiredWriteMode: ImplementerWriteMode;
  credentialFailure?: string | undefined;
  capabilityFailure?: string | undefined;
}

export type ContextLengthSource =
  | 'explicit'
  | 'detected'
  | 'models-dev'
  | 'runtime'
  | 'known-catalog'
  | 'conservative-fallback';

export interface ResolvedProfileContextLength {
  contextLength: number;
  source: ContextLengthSource;
  usedConservativeContextLength: boolean;
}
