import { resolveImplementerProfiles } from '../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../core/config/accessors/reviewer-runner.js';
import { runnerSlotId, runnerRoleForSlot } from '../core/config/accessors/runner-config.js';
import type {
  CliRouteInputs,
  RememberedToolCatalog,
} from '../core/readiness/checks/cli-readiness.js';
import { CLI_TOOL_IDS } from '../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../core/runners/cli-tool/types.js';
import { routeAuthState } from '../core/runners/route-auth.js';
import type { Config } from '../core/schemas/config.js';
import type { CliReadinessResult } from '../core/schemas/readiness.js';
import type { WorkflowOpts } from '../core/types/config-options.js';
import { loadRememberedSnapshot } from '../engine/detection/cache/store.js';
import type { RememberedCliCatalog } from '../engine/detection/cache/schema.js';
import { cliSeatDiscoveryContext } from '../engine/detection/cli-context.js';
import { detectAvailableCliReadiness } from '../engine/detection/detect.js';
import {
  type RouteCatalogReads,
  savedRouteCatalog,
  routeReadsCatalog,
  freshRouteCatalog,
} from '../engine/detection/route-catalog.js';
import { detectRunnerEvidence } from '../engine/detection/runner-evidence/detect.js';
import { resolveSeatModel } from '../engine/runners/host-model-selection.js';
import {
  type RunnerCandidate,
  runnerCandidates,
} from '../engine/runners/prepare-execution/runner-candidates.js';

export type DetectCliReadiness = (input: {
  projectDir: string;
  config: Config;
  opts: WorkflowOpts;
}) => Promise<readonly CliReadinessResult[]>;

function configuredCliTools(config: Config): CliToolId[] {
  const tools = new Set<CliToolId>();
  if (config.planner.kind === 'cli') tools.add(config.planner.tool);
  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured' && reviewer.runner.kind === 'cli') {
    tools.add(reviewer.runner.tool);
  }
  try {
    for (const profile of resolveImplementerProfiles(config).profiles) {
      if (profile.config.kind === 'cli') tools.add(profile.config.tool);
    }
  } catch {
    // Config readiness reports the invalid profile, so doctor does not guess a context here.
  }
  return CLI_TOOL_IDS.filter((tool) => tools.has(tool));
}

export const detectConfiguredCliReadiness: DetectCliReadiness = async ({ projectDir, config }) => {
  const tools = configuredCliTools(config);
  if (tools.length === 0) return [];
  return detectAvailableCliReadiness({ projectDir, tools });
};

/**
 * What doctor and a headless first run read each CLI seat's route against, the way start reads it:
 * the model the seat calls, and the tool's model list. The list is read fresh only when no saved
 * list counts for the route (`savedRouteCatalog`), the seat's route waits on it, and the tool is
 * ready or refused only on sign-in; `routeCatalogs` holds those reads, so a later pass over the
 * same seats reads no list again. A tool read fresh is read against that read alone: it names the
 * project, so it serves every route of the tool a saved list serves.
 */
export async function readConfiguredCliRoutes(
  input: Readonly<{
    projectDir: string;
    config: Config;
    cliReadiness: readonly Pick<CliReadinessResult, 'tool' | 'status' | 'providerAuth'>[];
    routeCatalogs: RouteCatalogReads;
  }>,
): Promise<CliRouteInputs> {
  const { projectDir, config } = input;
  const snapshot = await loadRememberedSnapshot(projectDir);
  const saved: RememberedCliCatalog[] = [];
  const seatModels = new Map<string, string | undefined>();
  let candidates: readonly RunnerCandidate[];
  try {
    candidates = runnerCandidates(config, 'new-workflow').candidates;
  } catch {
    // Runner readiness reports the invalid profile; every route then reads its configured model.
    return {
      seatModels,
      catalogs: (snapshot?.cliCatalogs ?? []).flatMap(
        ({ tool }) => savedRouteCatalog(snapshot, tool, undefined) ?? [],
      ),
    };
  }
  for (const { slot, runner } of candidates) {
    if (runner.kind !== 'cli') continue;
    const seatModel = await resolveSeatModel(
      runner,
      process.env,
      savedRouteCatalog(snapshot, runner.tool, runner.model)?.models,
    );
    const catalog = savedRouteCatalog(snapshot, runner.tool, seatModel.model);
    if (catalog !== undefined && !saved.includes(catalog)) saved.push(catalog);
    seatModels.set(runnerSlotId(slot), seatModel.model);
    const readiness = input.cliReadiness.find((result) => result.tool === runner.tool);
    if (
      (readiness?.status === 'ready' || readiness?.status === 'unauthenticated') &&
      routeReadsCatalog(
        routeAuthState({
          tool: runner.tool,
          model: seatModel.model,
          providerAuth: readiness.providerAuth,
          catalog,
        }),
      )
    ) {
      await freshRouteCatalog(input.routeCatalogs, runner.tool, () =>
        detectRunnerEvidence({
          context: cliSeatDiscoveryContext({ role: runnerRoleForSlot(slot), runner, config }),
          projectDir,
          includeCatalog: true,
          catalogNamesProject: true,
        }),
      );
    }
  }
  const catalogs: RememberedToolCatalog[] = saved.filter(
    (catalog) => !input.routeCatalogs.has(catalog.tool),
  );
  for (const [tool, read] of input.routeCatalogs) {
    const catalog = await read;
    if (catalog !== undefined) catalogs.push({ tool, ...catalog });
  }
  return { seatModels, catalogs };
}
