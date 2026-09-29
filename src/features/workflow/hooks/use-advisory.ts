import { modeAdviceStore } from '../../../stores/workflow/mode-advice.js';
import type { AdvisorResult } from '../../../engine/orchestrator/planning/mode-advisor.js';

export function useAdvisory(): AdvisorResult | null {
  return modeAdviceStore.use((s) => s.advice);
}
