import type { DetectedModel } from '../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../core/discovery/runner-evidence.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { RouteAuthState } from '../../core/runners/route-auth.js';

export type RouteCatalog = Readonly<{
  models: readonly DetectedModel[];
  missingOnce?: readonly string[] | undefined;
}>;

/** One preparation's fresh model-list reads, one per tool: every seat of a tool shares the first. */
export type RouteCatalogReads = Map<CliToolId, Promise<RouteCatalog | undefined>>;

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
