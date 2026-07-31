import { useEffect, useState } from 'react';
import {
  DEFAULT_SELECTION,
  IMPLEMENTER_JACKS,
  PLANNER_JACKS,
  type PairingSelection,
} from '../matrix/pairings.js';

export const PAIRING_CYCLE_MS = 4000;

// One crossing per jack on each axis — the diagonal of the patch field below.
export const CYCLE_PAIRINGS = [
  DEFAULT_SELECTION,
  { plannerId: 'codex', implementerId: 'lm-studio' },
  { plannerId: 'opencode', implementerId: 'deepseek' },
  { plannerId: 'aider', implementerId: 'groq' },
  { plannerId: 'anthropic', implementerId: 'openrouter' },
  { plannerId: 'agent-sdk', implementerId: 'together' },
] as const satisfies readonly PairingSelection[];

export interface PairingStatus {
  readonly plannerLabel: string;
  readonly plannerModel: string | null;
  readonly implementerLabel: string;
  readonly implementerModel: string;
}

export function pairingStatus({ plannerId, implementerId }: PairingSelection): PairingStatus {
  const planner = PLANNER_JACKS[plannerId];
  const implementer = IMPLEMENTER_JACKS[implementerId];

  return {
    plannerLabel: planner.label,
    plannerModel: 'model' in planner.runner ? planner.runner.model : null,
    implementerLabel: implementer.label,
    implementerModel: implementer.runner.model,
  };
}

export function usePairingCycle(paused: boolean): PairingSelection {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (paused) return;

    let timer = 0;

    function advance(): void {
      setIndex((current) => (current + 1) % CYCLE_PAIRINGS.length);
    }

    function run(): void {
      window.clearInterval(timer);
      if (!document.hidden) timer = window.setInterval(advance, PAIRING_CYCLE_MS);
    }

    run();
    document.addEventListener('visibilitychange', run);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [paused]);

  return CYCLE_PAIRINGS[index] ?? DEFAULT_SELECTION;
}
