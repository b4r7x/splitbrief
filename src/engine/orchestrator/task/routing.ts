import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowContext } from '../types.js';
import type { RoutingDecision } from '../context-routing/types.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { createImplementer } from '../../runners/factory.js';
import { createImplementerPublisher } from '../events.js';
import type { Implementer } from '../../implementers/types.js';

export function configForProfile(
  config: WorkflowContext['config'],
  profile: ResolvedImplementerProfile,
): WorkflowContext['config'] {
  return { ...config, implementer: profile.config };
}

export function selectedProfileFromDecision(
  profiles: ResolvedImplementerProfile[],
  decision: RoutingDecision,
): ResolvedImplementerProfile | undefined {
  if (decision.selectedProfile === undefined) return undefined;
  return profiles.find((profile) => profile.name === decision.selectedProfile);
}

export async function createTaskImplementer(opts: {
  wctx: WorkflowContext;
  profile: ResolvedImplementerProfile;
  taskConfig: WorkflowContext['config'];
  singleImplementerMode: boolean;
}): Promise<Implementer> {
  if (opts.singleImplementerMode && opts.profile.isDefault) return opts.wctx.implementer;
  const factory = opts.wctx.createImplementer ?? createImplementer;
  return factory(opts.taskConfig, { publisher: createImplementerPublisher(opts.wctx.bus) });
}

export function retryProfileOverrideForTask(wctx: WorkflowContext, task: Task): string | undefined {
  if (!wctx.retryProfileOverride) return undefined;
  if (wctx.retryProfileOverrideTaskId !== undefined && wctx.retryProfileOverrideTaskId !== task.id)
    return undefined;
  return wctx.retryProfileOverride;
}

export function routingBlockMessage(decision: RoutingDecision): string {
  const context =
    decision.contextLength === undefined
      ? `${decision.estimatedTokens} estimated tokens`
      : `${decision.estimatedTokens}/${decision.contextLength} estimated tokens`;
  return [
    `Task ${decision.taskId} cannot be routed to an implementer profile (${context}).`,
    'Pause and revise the plan, reduce required context, or configure a larger implementer profile.',
    decision.reason,
  ].join(' ');
}
