import {
  type SeatFallback,
  fallbackBlockedReason,
  fallbackRunner,
} from '../../../../core/crew/fallback.js';
import type { CrewSeatId } from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import type { SavedCatalog } from '../../../../core/discovery/catalog-read-merge.js';
import type { CliProviderAuth } from '../../../../core/discovery/detection/auth.js';
import { classifyHaltSignature } from '../../../../core/pipeline-spec/halts.js';
import { seatRouteModel } from '../../../../core/providers/automatic-model.js';
import { PROVIDER_ORACLE_TOOL_IDS } from '../../../../core/runners/cli-tool/catalog.js';
import { type RouteAuthState, routeAuthState } from '../../../../core/runners/route-auth.js';
import { runnerRoleForActiveRole } from '../../../../core/runners/seat-roles.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { SeatSwapCandidate } from '../../../../core/schemas/recovery/schemas.js';
import type { ReviewerConfig } from '../../../../core/schemas/runner/reviewer.js';
import { includes } from '../../../../utils/type-guards.js';
import { loadRememberedSnapshot } from '../../../detection/cache/store.js';
import type { DetectionCacheSnapshot } from '../../../detection/cache/schema.js';
import { cliSeatDiscoveryContext } from '../../../detection/cli-context.js';
import { detectAvailableCliTools } from '../../../detection/detect.js';
import {
  savedRouteCatalog,
  routeReadsCatalog,
  freshRouteCatalog,
} from '../../../detection/route-catalog.js';
import { detectRunnerEvidence } from '../../../detection/runner-evidence/detect.js';
import type { ModelCacheAccessor } from '../../../providers/model/runtime-snapshot.js';
import { readSeatOfRecord } from './of-record.js';
import { seatCandidateOfRunner } from './switch/config.js';

type SeatRunner = Config['planner'] | Config['implementer'] | ReviewerConfig;

/** A CLI-hosted seat can name the tool it is leaving; an API or shell seat cannot. */
function currentSeatTool(runner: SeatRunner): string {
  return runner.kind === 'cli' ? runner.tool : '';
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
    signal: AbortSignal | undefined;
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
        signal: input.signal,
      });
      providerAuth = evidence.providerAuth ?? UNREAD_PROVIDER_AUTH;
      catalog =
        evidence.catalog.kind === 'success' ? { models: evidence.catalog.value } : undefined;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      providerAuth = UNREAD_PROVIDER_AUTH;
      catalog = undefined;
    }
  }
  return routeAuthState({ tool: runner.tool, model: runner.model, providerAuth, catalog });
}

/**
 * Why the halt would not take the declared fallback, or `undefined` when it would. The remembered
 * row decides when it takes the fallback or saw the tool ready. A missing or not-ready row that
 * refuses it is checked live once, on the tool's catalog channel: the pass may be absent (a
 * headless project, a fresh clone) or older than the tool's install or sign-in. A route that then
 * waits on the tool's model list reads it fresh once, as the switch's own preparation does.
 */
async function fallbackDecision(
  input: Readonly<{
    projectDir: string;
    seat: CrewSeatId;
    config: Config;
    fallback: SeatFallback;
    remembered: DetectionCacheSnapshot | null;
    signal: AbortSignal | undefined;
  }>,
): Promise<string | undefined> {
  const { fallback, remembered } = input;
  const row = remembered?.cliTools.find((cli) => cli.tool === fallback.tool);
  let catalog: SavedCatalog | undefined = savedRouteCatalog(
    remembered,
    fallback.tool,
    seatRouteModel(fallback.model, fallback.tool, row?.selectedModel),
  );
  const blocked = fallbackBlockedReason(fallback, row, catalog);
  const runner = fallbackRunner(fallback);
  if (blocked === undefined || row?.diagnostic.state === 'ready' || runner?.kind !== 'cli') {
    return blocked;
  }
  const [live] = await detectAvailableCliTools({
    projectDir: input.projectDir,
    tools: [runner.tool],
    signal: input.signal,
  });
  const state = live?.diagnostic.state;
  if (
    (state === 'ready' || state === 'unauthenticated') &&
    routeReadsCatalog(
      routeAuthState({
        tool: runner.tool,
        model: seatRouteModel(runner.model, runner.tool, live?.selectedModel),
        providerAuth: live?.providerAuth,
        catalog,
      }),
    )
  ) {
    catalog = await freshRouteCatalog(new Map(), runner.tool, () =>
      detectRunnerEvidence({
        context: cliSeatDiscoveryContext({
          role: runnerRoleForActiveRole(CREW_SEAT_ROLES[input.seat]),
          runner,
          config: input.config,
        }),
        projectDir: input.projectDir,
        includeCatalog: true,
        catalogNamesProject: true,
        signal: input.signal,
      }),
    );
  }
  return fallbackBlockedReason(fallback, live, catalog);
}

/**
 * The swap offer a seat-down halt carries: the seat, the identity it was on, and
 * every CLI tool the last readiness pass remembered. A CLI seat always gets a
 * context, so its route's meaning reaches the halt with nothing else detected. A declared fallback
 * the pass saw ready or unverified, or a live check confirms, leads the rows with its own model
 * and effort; one it cannot run is not offered, and the halt names why. `switchSeatOffer` narrows
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
    /** Required so no caller drops the run's stop: it ends a live check of the route or the fallback. */
    signal: AbortSignal | undefined;
    implementerProfile?: string | undefined;
    /** The tool's own words on the halted call; a model refusal re-reads the route's evidence. */
    refusal?: string | undefined;
  }>,
): Promise<SeatSwapContext | undefined> {
  // A halt holds no discovery context — the run is stopping, not detecting — so
  // the snapshot is read for what it remembers; only a model refusal re-reads its
  // route's credential and model catalog (`haltRouteAuth`), and only a fallback the snapshot
  // would refuse is checked live (`fallbackDecision`). The offer is a suggestion the
  // operator confirms; the seat is re-prepared from scratch when they take it.
  const remembered = await loadRememberedSnapshot(input.projectDir);
  const rememberedTools = remembered?.cliTools ?? [];
  const currentTool = currentSeatTool(input.runner);
  const routeAuth = await haltRouteAuth(input, remembered);
  let detectedTools: DetectedSeatTool[] = rememberedTools.map((cli) => ({
    tool: cli.tool,
    ready: cli.diagnostic.state === 'ready',
  }));
  const record = readSeatOfRecord(input);
  const fallback = record.kind === 'read' ? record.seat?.fallback : undefined;
  const configRevision = record.kind === 'read' ? record.configRevision : undefined;
  const fallbackReadFailed = record.kind === 'read-failed' ? true : undefined;
  let blockedReason: string | undefined;
  if (fallback !== undefined) {
    blockedReason = await fallbackDecision({
      projectDir: input.projectDir,
      seat: input.seat,
      config: input.config,
      fallback,
      remembered,
      signal: input.signal,
    });
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
    from: seatCandidateOfRunner(input.runner),
    detectedTools,
    ...(fallback !== undefined && { fallback }),
    ...(blockedReason !== undefined && { fallbackBlockedReason: blockedReason }),
    ...(fallbackReadFailed !== undefined && { fallbackReadFailed }),
    ...(configRevision !== undefined && { configRevision }),
    ...(routeAuth !== undefined && { routeAuth }),
  };
}

/**
 * One row of the discovery snapshot as the recovery context carries it: a tool
 * the machine detected for this seat, whether that detection came back ready to
 * run, and the model, effort and variant when the row is the seat's declared
 * fallback rather than a bare detection.
 */
export type DetectedSeatTool = Readonly<{
  tool: string;
  model?: string | undefined;
  effort?: SeatSwapCandidate['effort'];
  variant?: string | undefined;
  ready: boolean;
}>;

/**
 * What a seat-down halt needs to offer a swap: which seat went down, the
 * identity it was on, the detection snapshot to pick a replacement from, and —
 * when the seat declared a fallback the last readiness pass cannot run — why
 * that fallback is not offered. A declared fallback the snapshot saw ready or
 * unverified leads `detectedTools`, so the offer lists it first.
 */
export type SeatSwapContext = Readonly<{
  seat: CrewSeatId;
  currentTool: string;
  currentModel?: string | undefined;
  /** The seat the halted call ran on, as the offer records it. */
  from?: SeatSwapCandidate | undefined;
  modelCache?: ModelCacheAccessor | undefined;
  detectedTools: readonly DetectedSeatTool[];
  fallback?: SeatSwapCandidate | undefined;
  fallbackBlockedReason?: string | undefined;
  fallbackReadFailed?: true | undefined;
  /**
   * The config document's hash as the halt read it. The automatic-switch intent
   * records it so the engine can refuse to move a seat whose config changed
   * underneath it.
   */
  configRevision?: string | undefined;
  /**
   * What the halted seat's model route means, from the tool's own credential
   * listing and model catalog, both read fresh on a model refusal.
   * It tells a route refusal that is a sign-out from a model the tool cannot
   * serve. Absent for a seat no CLI tool hosts.
   */
  routeAuth?: RouteAuthState | undefined;
}>;
