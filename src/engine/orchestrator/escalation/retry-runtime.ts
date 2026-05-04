import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { configError } from '../../../core/config/errors.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles, type ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { createImplementerPublisher } from '../events.js';
import { createImplementer } from '../../runners/factory.js';
import type { EscalationContext } from './types.js';

export type RetryRuntime = {
  config: Config;
  implementer: import('../../implementers/types.js').Implementer;
  implementerProfile?: string | undefined;
  profile?: ResolvedImplementerProfile | undefined;
};

export function retryConfigForProfile(config: Config, profile: ResolvedImplementerProfile): Config {
  return { ...config, implementer: profile.config };
}

export function stateForRetryProfile(state: WorkflowState, profile: ResolvedImplementerProfile): WorkflowState {
  const { implementerModel: _previousImplementerModel, ...stateWithoutImplementerModel } = state;
  const model = getRunnerModelName(profile.config);
  return {
    ...stateWithoutImplementerModel,
    implementerTool: getRunnerDisplayName(profile.config),
    ...(model !== undefined && { implementerModel: model }),
  };
}

export async function createRetryRuntime(ctx: EscalationContext, profileOverride: string | undefined): Promise<RetryRuntime> {
  if (profileOverride === undefined) {
    return {
      config: ctx.config,
      implementer: ctx.implementer,
      ...(ctx.implementerProfile !== undefined && { implementerProfile: ctx.implementerProfile }),
    };
  }

  const profile = resolveImplementerProfiles(ctx.config).profiles.find(candidate => candidate.name === profileOverride);
  if (!profile) throw configError.profileNotFound(profileOverride);

  const config = retryConfigForProfile(ctx.config, profile);
  const factory = ctx.createImplementer ?? createImplementer;
  return {
    config,
    implementer: await factory(config, { publisher: createImplementerPublisher(ctx.bus) }),
    implementerProfile: profile.name,
    profile,
  };
}
