import type {
  ImplementerCostTier,
  ImplementerWriteMode,
} from '../../../core/schemas/implementer-config.js';
import type { Task } from '../../../core/schemas/task.js';
import { uniqueSorted } from '../../../utils/collections.js';
import { looksLikeFilePath } from '../../../utils/path-patterns.js';
import type { ProfileFit } from './types.js';

function normalizeScopePattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//, '');
}

function matchesTaskFilePattern(pattern: string, taskFile: string): boolean {
  return normalizeScopePattern(pattern) === normalizeScopePattern(taskFile);
}

export function requiredWriteModeForTask(task: Task): ImplementerWriteMode {
  const scopedWritePatterns = [
    ...(task.scope?.inBounds ?? []),
    ...(task.scope?.approvedOutOfBounds ?? []),
  ];

  const hasAdditionalPathScope = scopedWritePatterns.some((pattern) => {
    const normalized = normalizeScopePattern(pattern);
    return (
      normalized.length > 0 &&
      looksLikeFilePath(normalized) &&
      !matchesTaskFilePattern(normalized, task.file)
    );
  });

  return hasAdditionalPathScope ? 'direct' : 'extracted-code';
}

const COST_TIER_RANK: Record<ImplementerCostTier, number> = {
  local: 0,
  cheap: 1,
  standard: 2,
  frontier: 3,
  unknown: 4,
};

export function compareProfileRouteRank(left: ProfileFit, right: ProfileFit): number {
  const costRank = COST_TIER_RANK[left.profile.costTier] - COST_TIER_RANK[right.profile.costTier];
  if (costRank !== 0) return costRank;

  const contextRank = left.contextLength - right.contextLength;
  if (contextRank !== 0) return contextRank;

  return left.profile.name.localeCompare(right.profile.name);
}

export function rejectionReason(profileFit: ProfileFit, selected?: ProfileFit): string {
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

export function selectedReason(profileFit: ProfileFit): string {
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

export function costPosture(selected: ProfileFit | undefined, rejected: ProfileFit[]): string {
  if (!selected) return 'No capable implementer profile; no cost tier selected';
  const rejectedTiers = uniqueSorted(rejected.map((profileFit) => profileFit.profile.costTier));
  const rejectedNote =
    rejectedTiers.length > 0 ? `; rejected tiers: ${rejectedTiers.join(', ')}` : '';
  return `Selected ${selected.profile.costTier} cost tier via cheapest-capable routing${rejectedNote}`;
}
