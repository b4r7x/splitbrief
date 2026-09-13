import type { WorkflowMode } from '../schemas/enums.js';
import { MODES } from './modes.js';

// The counts are the pipeline spec's own, so no surface can disagree with what a run does.
export function describeModeCost(mode: WorkflowMode, { gateNames = false } = {}): string {
  const { plannerCalls, gates } = MODES[mode];
  const calls = `${plannerCalls} planning ${plannerCalls === 1 ? 'call' : 'calls'}`;
  const count = `${gates.length} gates`;
  const gateText = gateNames && gates.length > 0 ? `${count} (${gates.join(' + ')})` : count;
  return `${calls} · ${gateText}`;
}
