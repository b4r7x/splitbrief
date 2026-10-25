import type { EventBus, EngineEvent } from '../events/types.js';
import type { RunnerCallEvent } from '../calls/types.js';

const shownStepsByBus = new WeakMap<EventBus, Map<string, number>>();

function usageLimitKey(code: string, window: string, resetsAt?: number | undefined): string {
  return `${code}:${window}:${resetsAt ?? ''}`;
}

function getOrCreateShownSteps(bus: EventBus): Map<string, number> {
  let steps = shownStepsByBus.get(bus);
  if (steps === undefined) {
    steps = new Map<string, number>();
    shownStepsByBus.set(bus, steps);
  }
  return steps;
}

export function admitUsageLimitWarning(bus: EventBus, event: RunnerCallEvent): boolean {
  if (event.type !== 'call_warning') {
    return true;
  }
  const usage = event.warning.usage;
  if (usage === undefined) {
    return true;
  }
  const map = getOrCreateShownSteps(bus);
  const key = usageLimitKey(event.warning.code, usage.window, usage.resetsAt);
  const shown = map.get(key);
  if (shown !== undefined && usage.step <= shown) {
    return false;
  }
  map.set(key, usage.step);
  return true;
}

export function seedUsageLimitSteps(bus: EventBus, events: Iterable<EngineEvent>): void {
  const map = getOrCreateShownSteps(bus);
  for (const event of events) {
    if (event.type !== 'runner_call_warning') {
      continue;
    }
    const usage = event.warning.usage;
    if (usage === undefined) {
      continue;
    }
    const key = usageLimitKey(event.warning.code, usage.window, usage.resetsAt);
    const shown = map.get(key);
    if (shown === undefined || usage.step > shown) {
      map.set(key, usage.step);
    }
  }
}
