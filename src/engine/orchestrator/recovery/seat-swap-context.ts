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
import type { SavedCatalog } from '../../../core/discovery/catalog-read-merge.js';
import type { CliProviderAuth } from '../../../core/discovery/detection.js';
import { classifyHaltSignature } from '../../../core/pipeline-spec/halts.js';
import { PROVIDER_ORACLE_TOOL_IDS } from '../../../core/runners/cli-tool-catalog.js';
import { routeAuthState, type RouteAuthState } from '../../../core/runners/route-auth.js';
import { runnerRoleForActiveRole } from '../../../core/runners/seat-roles.js';
import { includes } from '../../../utils/type-guards.js';
import { loadRememberedSnapshot, type DetectionCacheSnapshot } from '../../detection/cache.js';
import { cliSeatDiscoveryContext } from '../../detection/cli-context.js';
import { savedRouteCatalog } from '../../detection/route-catalog.js';
import { detectRunnerEvidence } from '../../detection/runner-evidence.js';
import type { DetectedSeatTool, SeatSwapContext } from './builders/task.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';

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

/** A credential listing the halt could not read; the route then reads as `unknown`. */
const UNREAD_PROVIDER_AUTH: CliProviderAuth = { kind: 'unreadable', reason: 'exit-failure' };

/**
 * What the halted seat's route means. A model refusal re-reads the tool's credential listing and
 * model catalog once, fresh and together: the remembered pair has no age limit, and a sign-out it
 * predates would read as a model the tool does not list. Every other halt reads the remembered pair.
 */
async function haltRouteAuth(
  input: Readonly<{
    projectDir: string;
    seat: CrewSeatId;
    runner: SeatRunner;
    config: Config;
    refusal?: string | undefined;
  }>,
  remembered: DetectionCacheSnapshot | null,
): Promise<RouteAuthState | undefined> {
  const { runner } = input;
  if (runner.kind !== 'cli') return undefined;
  if (runner.model === undefined) return { kind: 'unchecked' };
  let providerAuth = remembered?.cliTools.find((cli) => cli.tool === runner.tool)?.providerAuth;
  let catalog: SavedCatalog | undefined = savedRouteCatalog(remembered, runner.tool, runner.model);
  if (
    includes(PROVIDER_ORACLE_TOOL_IDS, runner.tool) &&
    classifyHaltSignature([input.refusal ?? '']) === 'missing-model'
  ) {
    try {
      const evidence = await detectRunnerEvidence({
        context: cliSeatDiscoveryContext({
          role: runnerRoleForActiveRole(CREW_SEAT_ROLES[input.seat]),
          runner,
          config: input.config,
        }),
        projectDir: input.projectDir,
        includeCatalog: true,
        catalogNamesProject: true,
      });
      providerAuth = evidence.providerAuth ?? UNREAD_PROVIDER_AUTH;
      catalog =
        evidence.catalog.kind === 'success' ? { models: evidence.catalog.value } : undefined;
    } catch {
      providerAuth = UNREAD_PROVIDER_AUTH;
      catalog = undefined;
    }
  }
  return routeAuthState({ tool: runner.tool, model: runner.model, providerAuth, catalog });
}

/**
 * The swap offer a seat-down halt carries: the seat, the identity it was on, and
 * every CLI tool the last readiness pass remembered. A CLI seat always gets a
 * context, so its route's meaning reaches the halt with nothing else detected. A declared fallback the pass
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
    /** Required so no halt drops the run's cache: the fallback row names its model through it. */
    modelCache: ModelCacheAccessor | undefined;
    implementerProfile?: string | undefined;
    /** The tool's own words on the halted call; a model refusal re-reads the route's evidence. */
    refusal?: string | undefined;
  }>,
): Promise<SeatSwapContext | undefined> {
  // A halt holds no discovery context — the run is stopping, not detecting — so
  // the snapshot is read for what it remembers; only a model refusal re-reads its
  // route's credential and model catalog (`haltRouteAuth`). The offer is a suggestion the
  // operator confirms; the seat is re-prepared from scratch when they take it.
  const remembered = await loadRememberedSnapshot(input.projectDir);
  const rememberedTools = remembered?.cliTools ?? [];
  const currentTool = currentSeatTool(input.runner);
  const routeAuth = await haltRouteAuth(input, remembered);
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
    blockedReason = fallbackBlockedReason(
      fallback,
      detection,
      savedRouteCatalog(remembered, fallback.tool, fallback.model),
    );
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
  if (
    detectedTools.length === 0 &&
    fallback === undefined &&
    fallbackReadFailed === undefined &&
    routeAuth === undefined
  )
    return undefined;
  return {
    seat: input.seat,
    ...(input.modelCache !== undefined && { modelCache: input.modelCache }),
    currentTool,
    ...(input.runner.model !== undefined && { currentModel: input.runner.model }),
    detectedTools,
    ...(fallback !== undefined && { fallback }),
    ...(blockedReason !== undefined && { fallbackBlockedReason: blockedReason }),
    ...(fallbackReadFailed !== undefined && { fallbackReadFailed }),
    ...(configRevision !== undefined && { configRevision }),
    ...(routeAuth !== undefined && { routeAuth }),
  };
}
