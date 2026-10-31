import { routerStore } from '../../stores/navigation/router.js';
import { runViewStore } from '../../stores/workflow/run-view.js';
import type { RouteData } from '../../stores/navigation/router.js';
import type { RunHalt } from '../../core/run-view/halt.js';

/**
 * The BUILD profile the seat picker reads and saves. A halt on a named profile — on the run the
 * workflow screen shows, live or at rest — names it, because Try again and a seat switch run the
 * brief on that profile; otherwise it is the default profile. Only the BUILD seat has profiles:
 * the other seats read no profile.
 */
function haltedProfile(halt: RunHalt | null, route: RouteData): string | undefined {
  return route.screen === 'workflow' ? halt?.issue.selectedImplementerProfile : undefined;
}

export function usePickerProfile(): string | undefined {
  const halt = runViewStore.use((s) => s.halt);
  const route = routerStore.use((s) => s);
  return haltedProfile(halt, route);
}

export function readPickerProfile(): string | undefined {
  return haltedProfile(runViewStore.get().halt, routerStore.get());
}
