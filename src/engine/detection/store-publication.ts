import type { Config } from '../../core/schemas/config.js';
import type {
  DiscoveryRefreshLaneSummary,
  DiscoveryRefreshSummary,
} from '../../core/runtime/commands/types.js';
import type { DetectionSourceOutcome } from './types.js';
import { createProductionDetectionDeps } from './deps.js';
import type { DetectionLanePublication } from './lane-channel.js';
import type { ModelsDevRefreshOutcome } from './models-dev-lane.js';
import type {
  DetectionService,
  DetectionServiceResult,
  ResolvedDetectionSourceContexts,
} from './service.js';

export interface DetectionPublicationRequest {
  readonly id: number;
  readonly contexts: ResolvedDetectionSourceContexts;
}

/**
 * The engine publishes an already-resolved generation through this small
 * store-facing port. The port deliberately receives no discovery dependencies
 * or context labels from its caller.
 *
 * Two publication shapes, one rule: a startup load lands lane by lane as the
 * lanes settle, a manual refresh lands as one result because its caller
 * reports a single all-lane verdict.
 */
export interface DetectionPublicationPort {
  beginRefresh(
    input: Readonly<{ contexts: ResolvedDetectionSourceContexts }>,
  ): DetectionPublicationRequest;
  publishLane(
    input: Readonly<{
      lane: DetectionLanePublication;
      request: DetectionPublicationRequest;
    }>,
  ): boolean;
  publish(
    input: Readonly<{
      result: DetectionServiceResult;
      request: DetectionPublicationRequest;
    }>,
  ): boolean;
}

export interface CurrentDetectionConfig {
  readonly config: Config;
  readonly projectDir: string;
}

function sourceLane<Value extends object>(
  outcome: DetectionSourceOutcome<Value>,
): DiscoveryRefreshLaneSummary {
  switch (outcome.kind) {
    case 'fresh':
    case 'stale':
    case 'failed':
      return { outcome: outcome.kind };
    case 'not-run':
      return { outcome: 'not-run', reason: outcome.reason };
  }
}

function modelsDevLane(outcome: ModelsDevRefreshOutcome): DiscoveryRefreshLaneSummary {
  switch (outcome.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
    case 'stale':
    case 'failed':
      return { outcome: outcome.kind };
    case 'not-run':
      return { outcome: 'not-run', reason: outcome.reason };
  }
}

function legacyLanes(result: DetectionServiceResult): DiscoveryRefreshSummary['lanes'] {
  return {
    readiness: { outcome: 'fresh' },
    modelsDev:
      result.catalog === null
        ? { outcome: 'not-run', reason: 'uninitialized' }
        : { outcome: 'fresh' },
    cliModels: { outcome: 'fresh' },
  };
}

function refreshLanes(result: DetectionServiceResult): DiscoveryRefreshSummary['lanes'] {
  const outcomes = result.outcomes;
  if (outcomes === undefined) return legacyLanes(result);
  return {
    readiness: sourceLane(outcomes.readiness),
    modelsDev: modelsDevLane(outcomes.modelsDev),
    cliModels: sourceLane(outcomes.cliModels),
  };
}

function isSuccessful(outcome: DiscoveryRefreshLaneSummary['outcome']): boolean {
  return outcome === 'fresh' || outcome === 'cached' || outcome === 'not-modified';
}

function isUninitialized(lanes: DiscoveryRefreshSummary['lanes']): boolean {
  return Object.values(lanes).every(
    (lane) => lane.outcome === 'not-run' && lane.reason === 'uninitialized',
  );
}

function refreshStatus(
  lanes: DiscoveryRefreshSummary['lanes'],
): Exclude<DiscoveryRefreshSummary['status'], 'superseded'> {
  const values = Object.values(lanes);
  const successful = values.filter((lane) => isSuccessful(lane.outcome)).length;
  if (successful === values.length) return 'fresh';
  if (successful > 0) return 'partial';
  if (values.some((lane) => lane.outcome === 'stale')) return 'stale';
  if (values.some((lane) => lane.outcome === 'failed')) return 'failed';
  return isUninitialized(lanes) ? 'uninitialized' : 'not-run';
}

export function summarizeDetectionRefresh(input: {
  result: DetectionServiceResult;
  published: boolean;
}): DiscoveryRefreshSummary {
  const lanes = refreshLanes(input.result);
  return {
    status: input.published ? refreshStatus(lanes) : 'superseded',
    published: input.published,
    lanes,
  };
}

export function uninitializedDetectionRefreshSummary(): DiscoveryRefreshSummary {
  const lanes: DiscoveryRefreshSummary['lanes'] = {
    readiness: { outcome: 'not-run', reason: 'uninitialized' },
    modelsDev: { outcome: 'not-run', reason: 'uninitialized' },
    cliModels: { outcome: 'not-run', reason: 'uninitialized' },
  };
  return { status: 'uninitialized', published: false, lanes };
}

function hasUntrustedDependencyInput(input: object): boolean {
  return (
    Object.hasOwn(input, 'deps') ||
    Object.hasOwn(input, 'contexts') ||
    Object.hasOwn(input, 'sourceContexts')
  );
}

/**
 * Compute only the safe opaque context labels for cache hydration. Publication
 * functions below independently construct their own dependency closures.
 */
export function detectionContextsForCurrentConfig(
  current: CurrentDetectionConfig,
): ResolvedDetectionSourceContexts {
  return createProductionDetectionDeps(current).sourceContexts;
}

export async function loadDetectionForCurrentConfig(
  input: Readonly<{
    service: DetectionService;
    publication: DetectionPublicationPort;
    current: CurrentDetectionConfig;
  }>,
): Promise<void> {
  if (hasUntrustedDependencyInput(input) || hasUntrustedDependencyInput(input.current)) return;
  const deps = createProductionDetectionDeps(input.current);
  const request = input.publication.beginRefresh({ contexts: deps.sourceContexts });
  // Startup lanes are seconds apart; withholding the fast ones behind the CLI
  // probe lane is what leaves the model column on bundled fallbacks.
  await input.service.loadDetection({
    deps,
    projectDir: input.current.projectDir,
    onLane: (lane) => {
      input.publication.publishLane({ lane, request });
    },
  });
}

export async function refreshDetectionForCurrentConfig(
  input: Readonly<{
    service: DetectionService;
    publication: DetectionPublicationPort;
    getCurrent: () => CurrentDetectionConfig | null;
  }>,
): Promise<DiscoveryRefreshSummary> {
  if (hasUntrustedDependencyInput(input)) return uninitializedDetectionRefreshSummary();
  const current = input.getCurrent();
  if (current === null || hasUntrustedDependencyInput(current)) {
    return uninitializedDetectionRefreshSummary();
  }

  const deps = createProductionDetectionDeps(current);
  const request = input.publication.beginRefresh({ contexts: deps.sourceContexts });
  const result = await input.service.refreshDetection({ deps, projectDir: current.projectDir });
  const published = input.publication.publish({ result, request });
  return summarizeDetectionRefresh({ result, published });
}
