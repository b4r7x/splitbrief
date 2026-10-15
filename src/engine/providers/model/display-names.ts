import type { Config } from '../../../core/schemas/config.js';
import {
  candidateIdsOf,
  formatSeatCandidateIdentity,
  formatSeatChangeIdentities,
  type CrewSeatId,
  type formatSeatIdentity,
  type SeatIds,
} from '../../../core/crew/identity.js';
import { cliToolIdForCommand } from '../../../core/runners/cli-tool-catalog.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { seatIdentitiesFromConfig, type SeatChange } from '../../../core/state/seats.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { cliVocabularyTool, formatModelName } from '../../../core/model-display.js';
import { resolveModelCatalog } from './catalog.js';
import type { ModelCacheAccessor } from './resolution.js';

type SeatCandidate = Parameters<typeof candidateIdsOf>[0];

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

/** Resolves a recorded command and model through the same catalog as a configured seat. */
export function recordedSeatIdentityInput({
  seat,
  role,
  cache,
}: {
  seat: SeatIds;
  role: ActiveRunnerRole;
  cache: ModelCacheAccessor;
}): Parameters<typeof formatSeatIdentity>[0] {
  const tool =
    seat.kind === 'cli' || seat.kind === undefined
      ? (cliToolIdForCommand(seat.tool) ?? seat.tool)
      : seat.tool;
  const displayName =
    seat.model === undefined
      ? undefined
      : resolveModelDisplayName({
          providerId: tool,
          model: seat.model,
          role,
          kind: seat.kind,
          cache,
        });
  return { seat: { ...seat, tool }, displayName };
}

export function resolveSeatChangeIdentities({
  from,
  to,
  role,
  cache,
}: {
  from: SeatCandidate | string;
  to: SeatCandidate | string;
  role: ActiveRunnerRole;
  cache: ModelCacheAccessor;
}): Readonly<{ from: string; to: string }> {
  const inputFor = (seat: SeatCandidate) =>
    seat.model === undefined
      ? seat
      : recordedSeatIdentityInput({ seat: candidateIdsOf(seat), role, cache });
  if (typeof from === 'string' || typeof to === 'string') {
    const label = (seat: SeatCandidate | string) =>
      typeof seat === 'string'
        ? seat
        : formatSeatCandidateIdentity(
            seat,
            recordedSeatIdentityInput({ seat: candidateIdsOf(seat), role, cache }).displayName,
          );
    return { from: label(from), to: label(to) };
  }
  return formatSeatChangeIdentities(inputFor(from), inputFor(to));
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

export function resolveSpecMetadata(config: Config, cache: ModelCacheAccessor): SpecMetadata {
  const crew = seatIdentitiesFromConfig(config, resolveCrewDisplayNames(config, cache));
  return { planner: crew.plan, implementer: crew.build };
}

/**
 * A moved seat named in the catalog's words, or by configured ids when those words match.
 * The record keeps the identities it compares; a side it kept no ids for stays as recorded, and so does the other, so
 * one notice never spells the same model two ways. The same holds when the record kept no runner
 * kind for a side: without it a custom API provider that reuses a CLI tool's name would be
 * re-spelled as that CLI, so both recorded labels stand.
 */
export function labelSeatChange(change: SeatChange, cache: ModelCacheAccessor): SeatChange {
  const { beforeIds, afterIds } = change;
  if (beforeIds === undefined || afterIds === undefined) return change;
  if (beforeIds.kind === undefined || afterIds.kind === undefined) return change;
  const role = CREW_SEAT_ROLES[change.seat];
  const inputFor = (ids: SeatIds) => recordedSeatIdentityInput({ seat: ids, role, cache });
  const identities = formatSeatChangeIdentities(inputFor(beforeIds), inputFor(afterIds));
  return { ...change, before: identities.from, after: identities.to };
}
