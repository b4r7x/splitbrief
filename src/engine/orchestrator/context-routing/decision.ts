import type { ImplementerWriteMode } from '../../../core/schemas/implementer-config.js';
import { scopeEntryPatterns, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import type { Task } from '../../../core/schemas/task.js';
import { declaredPathProblem } from '../../implementers/bundle-baseline.js';
import { FILE_BUNDLE_MAX_FILES } from '../../implementers/file-bundle.js';
import type { ProfileFit } from './types.js';

function normalizeScopePattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//, '');
}

export function requiredWriteModeForTask(task: Task): ImplementerWriteMode {
  const files = task.suggestedFiles;
  if (task.action !== 'create' && task.action !== 'modify') return 'direct';
  if (files.length > FILE_BUNDLE_MAX_FILES) return 'direct';
  if (files.some((path, index) => declaredPathProblem(path, files.slice(0, index))))
    return 'direct';

  const namedScopePaths = taskDeclaredPatterns(task).flatMap(scopeEntryPatterns);
  const hasAdditionalPathScope = namedScopePaths.some(
    (pattern) => !files.some((file) => normalizeScopePattern(pattern) === file),
  );

  return hasAdditionalPathScope ? 'direct' : 'extracted-code';
}

export function compareProfileRouteRank(left: ProfileFit, right: ProfileFit): number {
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
  return `Selected profile ${profileFit.profile.name} (${profileFit.fit}, estimated ${profileFit.estimatedTokens}/${profileFit.contextLength} tokens${fallbackNote}${capabilityNote}${reductionNote})`;
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
