import type { Config } from '../../../core/schemas/config.js';
import { formatSeatIdentity, type CrewSeatId, type SeatIds } from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import type { SeatChange } from '../../../core/state/seats.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { cliVocabularyTool, formatModelName } from '../../../core/model-display.js';
import { resolveModelCatalog } from './catalog.js';
import type { ModelCacheAccessor } from './resolution.js';

export function resolveSeatDisplayName(
  runner: RunnerConfig,
  role: ActiveRunnerRole,
  cache: ModelCacheAccessor,
): string | undefined {
  if (!('model' in runner) || !runner.model) return undefined;

  const providerId =
    runner.kind === 'api' ? runner.provider : runner.kind === 'cli' ? runner.tool : undefined;

  if (!providerId) return undefined;

  return resolveModelDisplayName({
    providerId,
    model: runner.model,
    role,
    cache,
    kind: runner.kind,
  });
}

export function resolveModelDisplayName(input: {
  providerId: string;
  model: string;
  role: ActiveRunnerRole;
  cache: ModelCacheAccessor;
  kind?: RunnerKind | undefined;
}): string | undefined {
  const { providerId, model, role, cache, kind } = input;
  if (model === 'auto') return undefined;
  const models = resolveModelCatalog(providerId, {
    cache,
    role,
    ...(kind === undefined ? {} : { kind }),
  });
  const entry = models.find((m) => m.id === model || m.selectionId === model);
  if (entry?.displayName !== undefined) return entry.displayName;
  return formatModelName(model, cliVocabularyTool(providerId, kind));
}

export function resolveCrewDisplayNames(
  config: Config,
  cache: ModelCacheAccessor,
): Partial<Record<CrewSeatId, string>> {
  const implementer = resolveImplementerProfiles(config).defaultProfile.config;
  const reviewer = resolveReviewerRunner(config);

  const planName = resolveSeatDisplayName(config.planner, 'planner', cache);
  const buildName = resolveSeatDisplayName(implementer, 'implementer', cache);
  const reviewName =
    reviewer.source === 'planner'
      ? planName
      : resolveSeatDisplayName(reviewer.runner, 'reviewer', cache);

  return {
    ...(planName !== undefined && { plan: planName }),
    ...(buildName !== undefined && { build: buildName }),
    ...(reviewName !== undefined && { review: reviewName }),
  };
}

/**
 * A moved seat named in the catalog's words, on both sides or on neither. The record keeps the
 * identities it compares; a side it kept no ids for stays as recorded, and so does the other, so
 * one notice never spells the same model two ways. The same holds when the record kept no runner
 * kind for a side: without it a custom API provider that reuses a CLI tool's name would be
 * re-spelled as that CLI, so both recorded labels stand.
 */
export function labelSeatChange(change: SeatChange, cache: ModelCacheAccessor): SeatChange {
  const { beforeIds, afterIds } = change;
  if (beforeIds === undefined || afterIds === undefined) return change;
  if (beforeIds.kind === undefined || afterIds.kind === undefined) return change;
  const role = CREW_SEAT_ROLES[change.seat];
  const named = (ids: SeatIds): string =>
    formatSeatIdentity({
      seat: ids,
      displayName:
        ids.model === undefined
          ? undefined
          : resolveModelDisplayName({
              providerId: ids.tool,
              model: ids.model,
              role,
              cache,
              kind: ids.kind,
            }),
      kind: ids.kind,
    });
  return { ...change, before: named(beforeIds), after: named(afterIds) };
}
