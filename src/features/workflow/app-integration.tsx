import type { ReactNode } from 'react';
import type { RewindTarget } from '../../core/state/build-rewind-action.js';
import {
  interruptTurn,
  requestCancel,
  requestClearQueue,
  requestRewind,
  type InterruptResult,
} from './handlers.js';
import { CostDrilldownOverlay } from './components/cost/drilldown-overlay.js';
import { PlanEditorHelpOverlay } from './components/plan-editor/help-overlay.js';
import { useMouseScroll } from './hooks/use-mouse-scroll.js';

export type { InterruptResult };

export function interruptWorkflowTurn(): InterruptResult {
  return interruptTurn();
}

export function requestWorkflowCancel(): boolean {
  return requestCancel();
}

export function requestWorkflowRewind(request: RewindTarget): boolean {
  return requestRewind(request);
}

export function requestWorkflowClearQueue(): number {
  return requestClearQueue();
}

export function useWorkflowShellMouseScroll(): void {
  useMouseScroll();
}

export function renderWorkflowCostDrilldownOverlay(): ReactNode {
  return <CostDrilldownOverlay />;
}

export function renderWorkflowPlanEditorHelpOverlay(): ReactNode {
  return <PlanEditorHelpOverlay />;
}
