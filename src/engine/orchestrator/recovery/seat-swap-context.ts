import type { Config } from '../../../core/schemas/config.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { loadRememberedSnapshot } from '../../detection/cache.js';
import type { DetectedSeatTool, SeatSwapContext } from './builders/task.js';

type SeatRunner = Config['planner'] | Config['implementer'];

/** A CLI-hosted seat can name the tool it is leaving; an API or shell seat cannot. */
function currentSeatTool(runner: SeatRunner): string {
  return runner.kind === 'cli' ? runner.tool : '';
}

/**
 * The swap offer a quota-blocked seat carries: the seat, the tool it is on, and
 * every CLI tool the last readiness pass remembered. `switchSeatOffer` narrows
 * that to the ready ones and drops the offer when nothing else is available.
 */
export async function loadSeatSwapContext(
  input: Readonly<{ projectDir: string; seat: CrewSeatId; runner: SeatRunner }>,
): Promise<SeatSwapContext | undefined> {
  // A halt holds no discovery context — the run is stopping, not detecting — so
  // the snapshot is read for what it remembers. The offer is a suggestion the
  // operator confirms; the seat is re-prepared from scratch when they take it.
  const remembered = await loadRememberedSnapshot(input.projectDir);
  if (remembered === null) return undefined;
  const detectedTools: DetectedSeatTool[] = remembered.cliTools.map((cli) => ({
    tool: cli.tool,
    ready: cli.diagnostic.state === 'ready',
  }));
  if (detectedTools.length === 0) return undefined;
  return { seat: input.seat, currentTool: currentSeatTool(input.runner), detectedTools };
}
