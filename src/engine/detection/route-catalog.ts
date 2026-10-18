import type { DetectedModel } from '../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../core/discovery/runner-evidence.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import {
  modelProviderAuthKey,
  servedProviders,
  type RouteAuthState,
} from '../../core/runners/route-auth.js';
import { lookupCliReadinessProbe } from '../runners/cli-tools/registry.js';
import type { DetectionCacheSnapshot, RememberedCliCatalog } from './cache.js';

export type RouteCatalog = Readonly<{
  models: readonly DetectedModel[];
  missingOnce?: readonly string[] | undefined;
}>;

/** One preparation's fresh model-list reads, one per tool: every seat of a tool shares the first. */
export type RouteCatalogReads = Map<CliToolId, Promise<RouteCatalog | undefined>>;

export function listsProjectProvidersOnRequest(tool: CliToolId): boolean {
  const catalog = lookupCliReadinessProbe({ tool, role: 'implementer' }).declared?.catalog;
  return catalog?.kind === 'catalog' && catalog.directoryHeader !== undefined;
}

/**
 * The saved model list a route of `tool` calling `model` is read against. A tool's listing that
 * carries the providers of the project's own config only when the read names the project, saved by
 * a read that did not name it (before the tool joined the crew, or by an earlier release), still
 * proves a route whose provider it serves; it never proves that a route does not work, so for any
 * other route it counts as not read and the route's fresh read decides.
 */
export function savedRouteCatalog(
  snapshot: DetectionCacheSnapshot | null,
  tool: string,
  model: string | undefined,
): RememberedCliCatalog | undefined {
  const catalog = snapshot?.cliCatalogs?.find((saved) => saved.tool === tool);
  if (
    catalog === undefined ||
    catalog.namesProject === true ||
    !listsProjectProvidersOnRequest(catalog.tool)
  ) {
    return catalog;
  }
  if (model === undefined) return undefined;
  const provider = modelProviderAuthKey(model);
  const served = servedProviders({ tool: catalog.tool, providerAuth: { kind: 'empty' }, catalog });
  return provider !== undefined && served.includes(provider) ? catalog : undefined;
}

/**
 * Whether a route waits on the tool's model list: no credential backs its provider and no list is
 * at hand. Every other route is decided without the list.
 */
export function routeReadsCatalog(route: RouteAuthState): boolean {
  return route.kind === 'unknown' && route.reason === 'catalog-not-read';
}

/**
 * The tool's model list read fresh, once per preparation. A failed read is no list, so the route
 * stays unread rather than signed out.
 */
export function freshRouteCatalog(
  reads: RouteCatalogReads,
  tool: CliToolId,
  readFresh: () => Promise<RunnerEvidence>,
): Promise<RouteCatalog | undefined> {
  let read = reads.get(tool);
  if (read === undefined) {
    read = readFresh().then((evidence) =>
      evidence.catalog.kind === 'success' ? { models: evidence.catalog.value } : undefined,
    );
    reads.set(tool, read);
  }
  return read;
}
