import { routerStore } from '../../stores/navigation/router.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import type { RouteData } from '../../stores/navigation/router.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';

/**
 * The BUILD profile the seat picker reads and saves. A halt on a named profile — open on the
 * recovery panel, or on the record of a run at rest — names it, because Try again and a seat
 * switch run the brief on that profile; otherwise it is the default profile. Only the BUILD
 * seat has profiles: the other seats read no profile.
 */
function haltedProfile(issue: RecoveryIssue | null, route: RouteData): string | undefined {
  if (issue !== null) return issue.selectedImplementerProfile;
  if (route.screen !== 'workflow' || route.execution.kind !== 'at-rest') return undefined;
  const { hydration } = route.run;
  return hydration.kind === 'loaded'
    ? hydration.state.pendingRecovery?.selectedImplementerProfile
    : undefined;
}

export function usePickerProfile(): string | undefined {
  const issue = recoveryNoticeStore.use((s) => s.issue);
  const route = routerStore.use((s) => s);
  return haltedProfile(issue, route);
}

export function readPickerProfile(): string | undefined {
  return haltedProfile(recoveryNoticeStore.get().issue, routerStore.get());
}
