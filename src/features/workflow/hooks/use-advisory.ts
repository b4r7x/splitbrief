import { eventsStore } from '../../../stores/workflow/events.js';
import type { AdvisorResult } from '../../../engine/orchestrator/planning/mode-advisor.js';

export function useAdvisory(): AdvisorResult | null {
  return eventsStore.use((s) => {
    for (let i = s.events.length - 1; i >= 0; i--) {
      const event = s.events[i];
      if (event?.type === 'mode_advice') {
        return {
          kind: event.kind,
          risk: event.risk,
          currentMode: event.currentMode,
          suggestedMode: event.suggestedMode,
          confidence: event.confidence,
          factors: event.factors,
          missing: event.missing,
        };
      }
    }
    return null;
  });
}
