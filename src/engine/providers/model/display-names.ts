import type { Config } from '../../../core/schemas/config.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { ActiveRunnerRole } from '../../../core/runners/cli-tool-catalog.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { resolveModelCatalog } from './catalog.js';
import type { ModelCacheAccessor } from './resolution.js';

export function resolveSeatDisplayName(
  runner: RunnerConfig,
  role: ActiveRunnerRole,
  cache: ModelCacheAccessor,
): string | undefined {
  if (!('model' in runner) || !runner.model || runner.model === 'auto') return undefined;

  const providerId =
    runner.kind === 'api'
      ? runner.provider
      : runner.kind === 'cli'
        ? runner.tool
        : runner.kind === 'agent-sdk'
          ? 'agent-sdk'
          : undefined;

  if (!providerId) return undefined;

  const models = resolveModelCatalog(providerId, { cache, role });
  const entry = models.find((m) => m.id === runner.model || m.selectionId === runner.model);
  return entry?.displayName;
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
