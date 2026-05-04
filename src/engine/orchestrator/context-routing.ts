import type { ResolvedImplementerProfile } from '../../core/config/accessors/implementer-profiles.js';
import { missingRunnerCredential } from '../../core/config/accessors/runner-credentials.js';
import type { ImplementerCostTier, ImplementerWriteMode } from '../../core/schemas/implementer-config.js';
import { isProviderId } from '../../core/schemas/enums.js';
import type { Task, TaskId } from '../../core/schemas/task.js';
import type { ProjectContext } from '../../core/state/types.js';
import { findKnownModel, getEffectiveModelId, lookupModelsDevModel, lookupRuntimeModel, type ModelCacheAccessor } from '../providers/model/resolution.js';
import { formatTaskPrompt } from '../spec/prompt-formatter.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import { buildLanguageContext } from '../spec/prompts/language-context.js';
import { buildSystemPreamble } from '../spec/prompts/system.js';
import { estimateTokens } from '../spec/token-budget.js';
import { looksLikeFilePath } from '../../utils/path-patterns.js';

export type { TaskContextFit, CurrentCodeContextMode } from '../events/workflow-events.js';
import type { TaskContextFit, CurrentCodeContextMode } from '../events/workflow-events.js';

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

interface ProfileFit {
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

export type ContextLengthSource = 'explicit' | 'models-dev' | 'runtime' | 'known-catalog' | 'conservative-fallback';

export interface ResolvedProfileContextLength {
  contextLength: number;
  source: ContextLengthSource;
  usedConservativeContextLength: boolean;
}

const DEFAULT_SAFETY_MARGIN = 0.15;
const DEFAULT_TIGHT_THRESHOLD = 0.8;
const DEFAULT_CONSERVATIVE_CONTEXT_LENGTH = 8192;
const TRUNCATION_MARKER = '// ... truncated to fit context window ...';
const FUNCTION_CONTEXT_HEADING = '### Current Code (relevant section)';
const WHOLE_FILE_CONTEXT_HEADING = '### Current Code';

const COST_TIER_RANK: Record<ImplementerCostTier, number> = {
  local: 0,
  cheap: 1,
  standard: 2,
  frontier: 3,
  unknown: 4,
};

function normalizeScopePattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//, '');
}


function matchesTaskFilePattern(pattern: string, taskFile: string): boolean {
  return normalizeScopePattern(pattern) === normalizeScopePattern(taskFile);
}

function requiredWriteModeForTask(task: Task): ImplementerWriteMode {
  const scopedWritePatterns = [
    ...(task.scope?.inBounds ?? []),
    ...(task.scope?.approvedOutOfBounds ?? []),
  ];

  const hasAdditionalPathScope = scopedWritePatterns.some(pattern => {
    const normalized = normalizeScopePattern(pattern);
    return normalized.length > 0
      && looksLikeFilePath(normalized)
      && !matchesTaskFilePattern(normalized, task.file);
  });

  return hasAdditionalPathScope ? 'direct' : 'extracted-code';
}

export function estimateFormattedTaskPromptTokens(opts: TaskPromptEstimateOptions): number {
  const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
  const prompt = formatTaskPrompt(opts.task, opts.context, opts.contextLength, languageContext);
  return estimateTokens(buildSystemPreamble(languageContext)) + estimateTokens(prompt);
}

export function classifyContextFit(
  estimatedTokens: number,
  contextLength: number,
  opts: ContextFitOptions = {},
): TaskContextFit {
  const safetyMargin = opts.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const tightThreshold = opts.tightThreshold ?? DEFAULT_TIGHT_THRESHOLD;
  const estimatedWithSafety = Math.ceil(estimatedTokens * (1 + safetyMargin));

  if (estimatedWithSafety > contextLength) return 'overflow';
  if (estimatedWithSafety > Math.floor(contextLength * tightThreshold)) return 'tight';
  return 'fits';
}

function profileProviderId(profile: ResolvedImplementerProfile): string {
  const { config } = profile;
  switch (config.kind) {
    case 'api':       return config.provider;
    case 'cli':       return config.tool;
    case 'shell':     return 'shell';
    case 'agent':     return 'agent';
    case 'agent-sdk': return 'agent-sdk';
  }
}

export function resolveProfileContextLength(
  profile: ResolvedImplementerProfile,
  conservativeContextLength: number,
  cache?: ModelCacheAccessor | undefined,
): ResolvedProfileContextLength {
  const contextLength = profile.config.contextLength;
  if (contextLength !== undefined) {
    return { contextLength, source: 'explicit', usedConservativeContextLength: false };
  }

  const providerId = profileProviderId(profile);
  if (!isProviderId(providerId)) {
    return { contextLength: conservativeContextLength, source: 'conservative-fallback', usedConservativeContextLength: true };
  }

  const modelId = getEffectiveModelId(providerId, profile.config.model);
  if (cache && modelId) {
    const modelsDev = lookupModelsDevModel(providerId, modelId, cache);
    if (modelsDev?.contextLength !== undefined) {
      return { contextLength: modelsDev.contextLength, source: 'models-dev', usedConservativeContextLength: false };
    }

    const runtime = lookupRuntimeModel(providerId, modelId, cache);
    if (runtime?.contextLength !== undefined) {
      return { contextLength: runtime.contextLength, source: 'runtime', usedConservativeContextLength: false };
    }
  }

  if (modelId) {
    const known = findKnownModel(providerId, modelId);
    if (known?.contextLength !== undefined) {
      return { contextLength: known.contextLength, source: 'known-catalog', usedConservativeContextLength: false };
    }
  }

  return { contextLength: conservativeContextLength, source: 'conservative-fallback', usedConservativeContextLength: true };
}

function currentCodeContextMode(task: Task, prompt: string): CurrentCodeContextMode {
  if (task.action !== 'modify' || !task.currentCode) return 'none';
  if (prompt.includes(FUNCTION_CONTEXT_HEADING)) return 'function-level';
  if (prompt.includes(TRUNCATION_MARKER)) return 'truncated';
  if (!prompt.includes(WHOLE_FILE_CONTEXT_HEADING)) return 'none';
  return prompt.includes(task.currentCode) ? 'whole-file' : 'truncated';
}

function assessProfile(opts: RouteTaskOptions, profile: ResolvedImplementerProfile): ProfileFit {
  const conservativeContextLength = opts.conservativeContextLength ?? DEFAULT_CONSERVATIVE_CONTEXT_LENGTH;
  const { contextLength, usedConservativeContextLength } = resolveProfileContextLength(
    profile,
    conservativeContextLength,
    opts.contextCache,
  );
  const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
  const untruncatedEstimatedTokens = estimateFormattedTaskPromptTokens({ task: opts.task, context: opts.context, languageContext });
  const prompt = formatTaskPrompt(opts.task, opts.context, contextLength, languageContext);
  const estimatedTokens = estimateTokens(buildSystemPreamble(languageContext)) + estimateTokens(prompt);
  const mode = currentCodeContextMode(opts.task, prompt);
  const currentCodeTruncated = mode === 'truncated';
  const formattedFit = classifyContextFit(estimatedTokens, contextLength, opts);
  const untruncatedFit = classifyContextFit(untruncatedEstimatedTokens, contextLength, opts);
  const fit = currentCodeTruncated && untruncatedFit === 'overflow'
    ? 'overflow'
    : formattedFit === 'fits' && (mode !== 'whole-file' && untruncatedFit !== 'fits')
      ? 'tight'
      : formattedFit;
  const requiredWriteMode = requiredWriteModeForTask(opts.task);
  const credentialFailure = credentialFailureReason(profile);
  const capabilityFailure = requiredWriteMode === 'direct' && profile.capabilities.writesFiles !== 'direct'
    ? `Task scope requires direct file writes; profile writes via ${profile.capabilities.writesFiles}`
    : undefined;

  return {
    profile,
    estimatedTokens,
    untruncatedEstimatedTokens,
    contextLength,
    currentCodeTruncated,
    currentCodeContextMode: mode,
    usedConservativeContextLength,
    requiredWriteMode,
    credentialFailure,
    capabilityFailure,
    fit,
  };
}

function credentialFailureReason(profile: ResolvedImplementerProfile): string | undefined {
  const missing = missingRunnerCredential(profile.config);
  if (!missing) return undefined;
  const credentialTarget = missing.envVar ? `profile apiKey or ${missing.envVar}` : 'profile apiKey';
  return `${missing.providerDisplayName} credentials are missing; set ${credentialTarget}`;
}

function compareProfileRouteRank(left: ProfileFit, right: ProfileFit): number {
  const costRank = COST_TIER_RANK[left.profile.costTier] - COST_TIER_RANK[right.profile.costTier];
  if (costRank !== 0) return costRank;

  const contextRank = left.contextLength - right.contextLength;
  if (contextRank !== 0) return contextRank;

  return left.profile.name.localeCompare(right.profile.name);
}

function rejectionReason(profileFit: ProfileFit, selected?: ProfileFit): string {
  if (profileFit.credentialFailure) {
    return profileFit.credentialFailure;
  }

  if (profileFit.capabilityFailure) {
    return profileFit.capabilityFailure;
  }

  const fallbackNote = profileFit.usedConservativeContextLength
    ? ' using conservative context-length fallback'
    : '';
  const reductionNote = currentCodeReductionNote(profileFit, ' after');

  if (profileFit.fit === 'overflow') {
    return `Estimated ${profileFit.estimatedTokens} tokens overflows ${profileFit.contextLength}-token context${fallbackNote}${reductionNote}`;
  }

  if (selected) {
    return `Not selected because ${selected.profile.name} has a lower routing rank`;
  }

  return `No capable profile selected${fallbackNote}`;
}

function selectedReason(profileFit: ProfileFit): string {
  const fallbackNote = profileFit.usedConservativeContextLength
    ? ' using conservative context-length fallback'
    : '';
  const reductionNote = currentCodeReductionNote(profileFit, ',');
  const capabilityNote = profileFit.requiredWriteMode === 'direct' ? ', direct-write capable' : '';
  return `Selected cheapest capable profile ${profileFit.profile.name} (${profileFit.fit}, estimated ${profileFit.estimatedTokens}/${profileFit.contextLength} tokens${fallbackNote}${capabilityNote}${reductionNote})`;
}

function currentCodeReductionNote(profileFit: ProfileFit, prefix: string): string {
  if (profileFit.currentCodeContextMode === 'function-level') {
    return `${prefix} current code reduced to function-level context from ${profileFit.untruncatedEstimatedTokens} whole-file tokens`;
  }
  if (profileFit.currentCodeContextMode === 'truncated') {
    return `${prefix} current code truncated from ${profileFit.untruncatedEstimatedTokens} untruncated tokens`;
  }
  return '';
}

function costPosture(selected: ProfileFit | undefined, rejected: ProfileFit[]): string {
  if (!selected) return 'No capable implementer profile; no cost tier selected';
  const rejectedTiers = Array.from(new Set(rejected.map(profileFit => profileFit.profile.costTier))).sort();
  const rejectedNote = rejectedTiers.length > 0 ? `; rejected tiers: ${rejectedTiers.join(', ')}` : '';
  return `Selected ${selected.profile.costTier} cost tier via cheapest-capable routing${rejectedNote}`;
}

export function routeTaskToImplementerProfile(opts: RouteTaskOptions): RoutingDecision {
  const profileFits = opts.profiles.map(profile => assessProfile(opts, profile));
  const capable = profileFits
    .filter(profileFit => profileFit.fit !== 'overflow' && !profileFit.credentialFailure && !profileFit.capabilityFailure)
    .toSorted(compareProfileRouteRank);
  const selected = capable.at(0);

  if (!selected) {
    const rejected = profileFits
      .toSorted(compareProfileRouteRank)
      .map(profileFit => ({
        profile: profileFit.profile.name,
        costTier: profileFit.profile.costTier,
        profileWriteMode: profileFit.profile.capabilities.writesFiles,
        requiredWriteMode: profileFit.requiredWriteMode,
        reason: rejectionReason(profileFit),
        fit: profileFit.fit,
        estimatedTokens: profileFit.estimatedTokens,
        untruncatedEstimatedTokens: profileFit.untruncatedEstimatedTokens,
        contextLength: profileFit.contextLength,
        currentCodeTruncated: profileFit.currentCodeTruncated,
        currentCodeContextMode: profileFit.currentCodeContextMode,
      }));

    const representative = profileFits
      .toSorted((left, right) => {
        const fitRank = Number(left.fit === 'overflow') - Number(right.fit === 'overflow');
        if (fitRank !== 0) return fitRank;
        return right.contextLength - left.contextLength || compareProfileRouteRank(left, right);
      })
      .at(0);
    const largestOverflow = rejected
      .toSorted((left, right) => right.contextLength - left.contextLength || left.profile.localeCompare(right.profile))
      .at(0);
    const hasCapabilityFailure = profileFits.some(profileFit => profileFit.capabilityFailure !== undefined);
    const hasCredentialFailure = profileFits.some(profileFit => profileFit.credentialFailure !== undefined);

    return {
      taskId: opts.task.id,
      requiredWriteMode: representative?.requiredWriteMode ?? 'extracted-code',
      fit: representative?.fit ?? 'overflow',
      estimatedTokens: representative?.estimatedTokens ?? largestOverflow?.estimatedTokens ?? 0,
      untruncatedEstimatedTokens: representative?.untruncatedEstimatedTokens ?? largestOverflow?.untruncatedEstimatedTokens ?? 0,
      contextLength: representative?.contextLength ?? largestOverflow?.contextLength,
      currentCodeTruncated: representative?.currentCodeTruncated ?? largestOverflow?.currentCodeTruncated ?? false,
      currentCodeContextMode: representative?.currentCodeContextMode ?? largestOverflow?.currentCodeContextMode ?? 'none',
      costPosture: costPosture(undefined, profileFits),
      reason: hasCredentialFailure
        ? 'No credential-usable implementer profile satisfies this task capability and context requirements'
        : hasCapabilityFailure
        ? 'No capable implementer profile satisfies this task capability and context requirements'
        : 'No capable implementer profile can fit this task prompt',
      rejected,
    };
  }

  const rejected = profileFits
    .filter(profileFit => profileFit.profile.name !== selected.profile.name)
    .toSorted(compareProfileRouteRank)
    .map(profileFit => ({
      profile: profileFit.profile.name,
      costTier: profileFit.profile.costTier,
      profileWriteMode: profileFit.profile.capabilities.writesFiles,
      requiredWriteMode: profileFit.requiredWriteMode,
      reason: rejectionReason(profileFit, selected),
      fit: profileFit.fit,
      estimatedTokens: profileFit.estimatedTokens,
      untruncatedEstimatedTokens: profileFit.untruncatedEstimatedTokens,
      contextLength: profileFit.contextLength,
      currentCodeTruncated: profileFit.currentCodeTruncated,
      currentCodeContextMode: profileFit.currentCodeContextMode,
    }));

  return {
    taskId: opts.task.id,
    selectedProfile: selected.profile.name,
    selectedCostTier: selected.profile.costTier,
    selectedWriteMode: selected.profile.capabilities.writesFiles,
    requiredWriteMode: selected.requiredWriteMode,
    fit: selected.fit,
    estimatedTokens: selected.estimatedTokens,
    untruncatedEstimatedTokens: selected.untruncatedEstimatedTokens,
    contextLength: selected.contextLength,
    currentCodeTruncated: selected.currentCodeTruncated,
    currentCodeContextMode: selected.currentCodeContextMode,
    costPosture: costPosture(selected, profileFits.filter(profileFit => profileFit.profile.name !== selected.profile.name)),
    reason: selectedReason(selected),
    rejected,
  };
}
