import { getRunnerCatalogDisplayName } from '../../../../core/config/accessors/runner-config.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { Planner } from '../../../planners/types.js';
import { createCustomRunnerRuntime } from '../../../runners/custom/runtime.js';
import type { CustomRunnerRuntimePort } from '../../../runners/types.js';
import type { OrchestratorCallbacks } from '../../types.js';

export function plannerUnavailableMessage(
  plannerConfig: Config['planner'],
  planner: Planner,
): string {
  const name = getRunnerCatalogDisplayName(plannerConfig);
  const reason = planner.unavailabilityReason?.();
  if (reason) return `Planner ${name} is not available: ${reason}.`;
  if (plannerConfig.kind === 'api') {
    return `Planner ${name} is not available. Check the API key, endpoint, and model.`;
  }
  return `Planner ${name} is not available. Make sure it's installed.`;
}

export function composeWorkflowCustomRunnerRuntime(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    callbacks: Pick<OrchestratorCallbacks, 'onApprovalNeeded' | 'onTieredApproval'>;
    interaction: 'interactive' | 'headless';
    allowRepoRunners: boolean;
  }>,
): CustomRunnerRuntimePort {
  return createCustomRunnerRuntime({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    sweepStaleReviews: true,
    // An artifact review confirms no protected operation.
    onArtifactApproval: (type, review) => input.callbacks.onApprovalNeeded(type, review, []),
    admission: {
      interaction: input.interaction,
      allowRepoRunners: input.allowRepoRunners,
      ...(input.callbacks.onTieredApproval === undefined
        ? {}
        : { onTieredApproval: input.callbacks.onTieredApproval }),
    },
  });
}
