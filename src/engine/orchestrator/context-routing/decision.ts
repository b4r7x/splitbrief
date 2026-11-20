import type { ImplementerWriteMode } from '../../../core/schemas/runner/implementer.js';
import { scopeEntryPatterns, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import type { Task } from '../../../core/schemas/task.js';
import { declaredPathProblem } from '../../implementers/file-bundle/baseline.js';
import { FILE_BUNDLE_MAX_FILES } from '../../implementers/file-bundle/contract.js';
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
    return `The request is larger than the context window${fallbackNote}${reductionNote}`;
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
  // Only a Prompt budget stops a brief, so a selected profile over its window has none.
  const budgetNote = profileFit.fit === 'overflow' ? '; no Prompt budget is set' : '';
  return `Selected profile ${profileFit.profile.name} (${profileFit.fit}${fallbackNote}${capabilityNote}${reductionNote}${budgetNote})`;
}

function currentCodeReductionNote(profileFit: ProfileFit, prefix: string): string {
  if (profileFit.currentCodeContextMode === 'function-level') {
    return `${prefix} current code reduced to function-level context`;
  }
  if (profileFit.currentCodeContextMode === 'truncated') {
    return `${prefix} current code truncated`;
  }
  return '';
}
