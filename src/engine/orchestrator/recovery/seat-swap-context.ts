import type { Config } from '../../../core/schemas/config.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { loadConfig } from '../../../core/config/load/io.js';
import { readImplementerProfileConfig } from '../../../core/config/accessors/implementer-profiles.js';
import {
  fallbackBlockedReason,
  seatFallback,
  type SeatFallback,
} from '../../../core/crew/fallback.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { loadRememberedSnapshot } from '../../detection/cache.js';
import type { DetectedSeatTool, SeatSwapContext } from './builders/task.js';

type SeatRunner = Config['planner'] | Config['implementer'] | NonNullable<Config['reviewer']>;

/** A CLI-hosted seat can name the tool it is leaving; an API or shell seat cannot. */
function currentSeatTool(runner: SeatRunner): string {
  return runner.kind === 'cli' ? runner.tool : '';
}

type SeatFallbackReadResult =
  | Readonly<{
      kind: 'read';
      fallback: SeatFallback | undefined;
      configRevision: string | undefined;
    }>
  | Readonly<{ kind: 'read-failed' }>;

export function readSeatFallbackOfRecord(
  input: Readonly<{
    projectDir: string;
    seat: CrewSeatId;
    config: Config;
    implementerProfile?: string | undefined;
  }>,
): SeatFallbackReadResult {
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(input.projectDir);
  } catch {
    return { kind: 'read-failed' };
  }
  const configOfRecord = loaded.revision === null ? input.config : loaded.config;
  const fallback =
    input.seat === 'build'
      ? readImplementerProfileConfig(configOfRecord, input.implementerProfile)?.fallback
      : seatFallback(configOfRecord, CREW_SEAT_ROLES[input.seat]);
  return { kind: 'read', fallback, configRevision: loaded.revision?.rawSha256 };
}

/**
 * The swap offer a seat-down halt carries: the seat, the identity it was on, and
 * every CLI tool the last readiness pass remembered. A declared fallback the pass
 * saw ready or unverified leads the rows with its own model and effort; one it
 * cannot run is not offered, and the halt names why. `switchSeatOffer` narrows
 * the rest to the ready ones and drops the offer when nothing is available.
 */
export async function loadSeatSwapContext(
  input: Readonly<{
    projectDir: string;
    seat: CrewSeatId;
    runner: SeatRunner;
    config: Config;
    implementerProfile?: string | undefined;
  }>,
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
  const record = readSeatFallbackOfRecord(input);
  const fallback = record.kind === 'read' ? record.fallback : undefined;
  const configRevision = record.kind === 'read' ? record.configRevision : undefined;
  const fallbackReadFailed = record.kind === 'read-failed' ? true : undefined;
  let blockedReason: string | undefined;
  if (fallback !== undefined) {
    const detection = rememberedTools.find((cli) => cli.tool === fallback.tool);
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
  if (detectedTools.length === 0 && fallback === undefined && fallbackReadFailed === undefined)
    return undefined;
  return {
    seat: input.seat,
    currentTool: currentSeatTool(input.runner),
    ...(input.runner.model !== undefined && { currentModel: input.runner.model }),
    detectedTools,
    ...(fallback !== undefined && { fallback }),
    ...(blockedReason !== undefined && { fallbackBlockedReason: blockedReason }),
    ...(fallbackReadFailed !== undefined && { fallbackReadFailed }),
    ...(configRevision !== undefined && { configRevision }),
  };
}
