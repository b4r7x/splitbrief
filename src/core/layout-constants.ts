import { inputHeightStore } from '../stores/input-height.js';
import { workflowStore } from '../stores/workflow.js';

/** Fixed chrome rows: L1 header (1) + agent status (1) + spacer (1) = 3 */
const L1 = 3;
/** Max chrome rows: L2 config line = 2 (0 when no config event) */
const L2 = 2;
/** Fixed chrome rows: feedback (1) + footer (1) = 2 */
const L4_FIXED = 2;

export function getChromeHeight(): number {
  const inputRows = inputHeightStore.get().rows;
  const hasConfig = workflowStore.get().events.some(ev => ev.type === 'workflow-config');
  const l2 = hasConfig ? L2 : 0;
  return L1 + l2 + L4_FIXED + inputRows;
}

export { L1, L2, L4_FIXED };
