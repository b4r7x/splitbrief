import type {
  ProfileFit,
  RejectedImplementerProfile,
  RoutingDecision,
  RouteTaskOptions,
} from './types.js';
import { assessProfile } from './assessment.js';
import {
  compareProfileRouteRank,
  rejectionReason,
  selectedReason,
  costPosture,
} from './helpers.js';

function toRejectedProfile(
  profileFit: ProfileFit,
  selected?: ProfileFit,
): RejectedImplementerProfile {
  return {
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
  };
}

export function routeTaskToImplementerProfile(opts: RouteTaskOptions): RoutingDecision {
  const profileFits = opts.profiles.map((profile) => assessProfile(opts, profile));
  const capable = profileFits
    .filter(
      (profileFit) =>
        profileFit.fit !== 'overflow' &&
        !profileFit.credentialFailure &&
        !profileFit.capabilityFailure,
    )
    .toSorted(compareProfileRouteRank);
  const selected = capable.at(0);

  if (!selected) {
    const rejected = profileFits
      .toSorted(compareProfileRouteRank)
      .map((profileFit) => toRejectedProfile(profileFit));

    const representative = profileFits
      .toSorted((left, right) => {
        const fitRank = Number(left.fit === 'overflow') - Number(right.fit === 'overflow');
        if (fitRank !== 0) return fitRank;
        return right.contextLength - left.contextLength || compareProfileRouteRank(left, right);
      })
      .at(0);
    const largestOverflow = rejected
      .toSorted(
        (left, right) =>
          right.contextLength - left.contextLength || left.profile.localeCompare(right.profile),
      )
      .at(0);
    const hasCapabilityFailure = profileFits.some(
      (profileFit) => profileFit.capabilityFailure !== undefined,
    );
    const hasCredentialFailure = profileFits.some(
      (profileFit) => profileFit.credentialFailure !== undefined,
    );

    return {
      taskId: opts.task.id,
      requiredWriteMode: representative?.requiredWriteMode ?? 'extracted-code',
      fit: representative?.fit ?? 'overflow',
      estimatedTokens: representative?.estimatedTokens ?? largestOverflow?.estimatedTokens ?? 0,
      untruncatedEstimatedTokens:
        representative?.untruncatedEstimatedTokens ??
        largestOverflow?.untruncatedEstimatedTokens ??
        0,
      contextLength: representative?.contextLength ?? largestOverflow?.contextLength,
      currentCodeTruncated:
        representative?.currentCodeTruncated ?? largestOverflow?.currentCodeTruncated ?? false,
      currentCodeContextMode:
        representative?.currentCodeContextMode ?? largestOverflow?.currentCodeContextMode ?? 'none',
      costPosture: costPosture(undefined, profileFits),
      reason: noCapableProfileReason(hasCredentialFailure, hasCapabilityFailure),
      rejected,
    };
  }

  const rejected = profileFits
    .filter((profileFit) => profileFit.profile.name !== selected.profile.name)
    .toSorted(compareProfileRouteRank)
    .map((profileFit) => toRejectedProfile(profileFit, selected));

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
    costPosture: costPosture(
      selected,
      profileFits.filter((profileFit) => profileFit.profile.name !== selected.profile.name),
    ),
    reason: selectedReason(selected),
    rejected,
  };
}

function noCapableProfileReason(
  hasCredentialFailure: boolean,
  hasCapabilityFailure: boolean,
): string {
  if (hasCredentialFailure)
    return 'No credential-usable implementer profile satisfies this task capability and context requirements';
  if (hasCapabilityFailure)
    return 'No capable implementer profile satisfies this task capability and context requirements';
  return 'No capable implementer profile can fit this task prompt';
}
