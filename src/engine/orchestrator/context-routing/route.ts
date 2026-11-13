import type {
  ProfileFit,
  RejectedImplementerProfile,
  RoutingDecision,
  RouteTaskOptions,
} from './types.js';
import { assessProfile } from './assessment.js';
import { compareProfileRouteRank, rejectionReason, selectedReason } from './decision.js';

function toRejectedProfile(
  profileFit: ProfileFit,
  selected?: ProfileFit,
): RejectedImplementerProfile {
  return {
    profile: profileFit.profile.name,
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
  // Only a Prompt budget the user set stops a brief; a window SPLITBRIEF knows or guesses orders
  // the choice. The fitting profiles go first by rank, then the default profile, then the profile
  // with the largest window, which has the best chance to take the whole brief. A recovery pin
  // routes over the pinned profile alone, so it is the one usable profile.
  const usable = profileFits.filter(
    (profileFit) =>
      !profileFit.credentialFailure &&
      !profileFit.capabilityFailure &&
      !(profileFit.userBudget && profileFit.fit === 'overflow'),
  );
  const selected =
    usable
      .filter((profileFit) => profileFit.fit !== 'overflow')
      .toSorted(compareProfileRouteRank)
      .at(0) ??
    usable.find((profileFit) => profileFit.profile.isDefault) ??
    usable
      .toSorted(
        (left, right) =>
          right.contextLength - left.contextLength || compareProfileRouteRank(left, right),
      )
      .at(0);

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
      usedConservativeContextLength: representative?.usedConservativeContextLength ?? false,
      currentCodeTruncated:
        representative?.currentCodeTruncated ?? largestOverflow?.currentCodeTruncated ?? false,
      currentCodeContextMode:
        representative?.currentCodeContextMode ?? largestOverflow?.currentCodeContextMode ?? 'none',
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
    selectedWriteMode: selected.profile.capabilities.writesFiles,
    requiredWriteMode: selected.requiredWriteMode,
    fit: selected.fit,
    estimatedTokens: selected.estimatedTokens,
    untruncatedEstimatedTokens: selected.untruncatedEstimatedTokens,
    contextLength: selected.contextLength,
    usedConservativeContextLength: selected.usedConservativeContextLength,
    currentCodeTruncated: selected.currentCodeTruncated,
    currentCodeContextMode: selected.currentCodeContextMode,
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
