import type { Config } from '../../../core/schemas/config.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import type { CliToolDetection } from '../../../core/discovery/detection.js';
import { readConfigDocument } from '../../../core/config/load/document.js';
import { loadRememberedSnapshot } from '../../detection/cache.js';
import type { DetectedSeatTool, SeatSwapContext } from './builders/task.js';

type SeatRunner = Config['planner'] | Config['implementer'] | NonNullable<Config['reviewer']>;

/** A CLI-hosted seat can name the tool it is leaving; an API or shell seat cannot. */
function currentSeatTool(runner: SeatRunner): string {
  return runner.kind === 'cli' ? runner.tool : '';
}

/** A readiness state that still runs the tool, so a declared fallback on it can be offered. */
function isOfferableFallbackState(detection: CliToolDetection): boolean {
  return detection.diagnostic.state === 'ready' || detection.diagnostic.state === 'unverified';
}

/**
 * Why the last readiness pass cannot run the declared fallback. An
 * `unavailable` state reads as `not installed`; every other non-ready state
 * names itself, so the halt says the same word the readiness report does.
 */
function fallbackBlockedReason(detection: CliToolDetection): string | undefined {
  if (isOfferableFallbackState(detection)) return undefined;
  const state = detection.diagnostic.state;
  return state === 'unavailable' ? 'not installed' : state;
}

/**
 * The swap offer a seat-down halt carries: the seat, the identity it was on, and
 * every CLI tool the last readiness pass remembered. A declared fallback the pass
 * saw ready or unverified leads the rows with its own model and effort; one it
 * cannot run is not offered, and the halt names why. `switchSeatOffer` narrows
 * the rest to the ready ones and drops the offer when nothing is available.
 */
export async function loadSeatSwapContext(
  input: Readonly<{ projectDir: string; seat: CrewSeatId; runner: SeatRunner }>,
): Promise<SeatSwapContext | undefined> {
  // A halt holds no discovery context — the run is stopping, not detecting — so
  // the snapshot is read for what it remembers. The offer is a suggestion the
  // operator confirms; the seat is re-prepared from scratch when they take it.
  const remembered = await loadRememberedSnapshot(input.projectDir);
  const rememberedTools = remembered?.cliTools ?? [];
  let detectedTools: DetectedSeatTool[] = rememberedTools.map((cli) => ({
    tool: cli.tool,
    ready: cli.diagnostic.state === 'ready',
  }));
  const fallback = input.runner.fallback;
  let blockedReason: string | undefined;
  if (fallback !== undefined) {
    const detection = rememberedTools.find((cli) => cli.tool === fallback.tool);
    if (detection === undefined) {
      blockedReason = 'not installed';
    } else {
      blockedReason = fallbackBlockedReason(detection);
      if (blockedReason === undefined) {
        detectedTools = [
          {
            tool: fallback.tool,
            ...(fallback.model !== undefined && { model: fallback.model }),
            ...(fallback.effort !== undefined && { effort: fallback.effort }),
            ...(fallback.variant !== undefined && { variant: fallback.variant }),
            ready: true,
          },
          ...detectedTools.filter((tool) => tool.tool !== fallback.tool),
        ];
      }
    }
  }
  if (detectedTools.length === 0 && fallback === undefined) return undefined;
  const configRevision = readConfigDocument(input.projectDir).revision?.rawSha256;
  return {
    seat: input.seat,
    currentTool: currentSeatTool(input.runner),
    ...(input.runner.model !== undefined && { currentModel: input.runner.model }),
    detectedTools,
    ...(blockedReason !== undefined && { fallbackBlockedReason: blockedReason }),
    ...(configRevision !== undefined && { configRevision }),
  };
}
