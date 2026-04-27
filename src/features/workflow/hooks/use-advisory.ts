import { useSyncExternalStore } from 'react';
import { getAdvisory, subscribeAdvisory } from '../../../engine/orchestrator/planning/mode-advisor.js';
import type { AdvisorResult } from '../../../engine/orchestrator/planning/mode-advisor.js';

export function useAdvisory(): AdvisorResult | null {
  return useSyncExternalStore(subscribeAdvisory, getAdvisory);
}
