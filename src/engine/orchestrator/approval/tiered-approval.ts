import type { Config } from '../../../core/schemas/config.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { ApprovalGrant } from '../../../core/schemas/approval-store.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import type { ApprovalTier } from '../../../core/schemas/config.js';
import type { TierMap } from './action-classifier.js';
import { classifyAction, extractActionPattern, matchesActionPattern } from './action-classifier.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { readApprovalsStore, mutateApprovalsStore } from '../../../core/approval/store.js';
import { error } from '../../../utils/error.js';
import { ActionClassSchema } from '../../../core/schemas/enums.js';
import { nowIso } from '../../../utils/format-time.js';

type ApprovalTierOverrides = NonNullable<Config['approval']>['tiers'];

export type GateActionInput = {
  actionDescription: string;
  task: Task;
  dependsOnFiles: string[];
  projectDir: string;
  sessionId: string;
  phase: Phase;
  taskId?: TaskId;
  bus: EventBus;
  callbacks: OrchestratorCallbacks;
  config: Config;
  getApprovalEnabled?: (() => boolean) | undefined;
  grants?: ApprovalGrant[];
};

export type GateDecision = {
  allow: boolean;
  reason?: string;
  tier?: ApprovalTier;
  actionClass?: ActionClass;
  actionDescription?: string;
  confirmReason?: string;
  confirmApprovals?: Array<{
    tier: 'confirm';
    actionClass: ActionClass;
    actionDescription: string;
    reason: string;
  }>;
};

export function isConfiguredHeadless(config: Config): boolean {
  return config.approval?.headless === true;
}

export function taskScopePatterns(task: Task): string[] {
  return [...(task.scope?.inBounds ?? []), ...(task.scope?.approvedOutOfBounds ?? [])];
}

function mergeGrant(grants: ApprovalGrant[], grant: ApprovalGrant): ApprovalGrant[] | null {
  const alwaysExists = grants.some(
    (g) => g.pattern === grant.pattern && g.class === grant.class && g.scope === 'always',
  );
  if (alwaysExists && grant.scope === 'session') return null;
  const filtered = grants.filter(
    (g) => !(g.pattern === grant.pattern && g.class === grant.class && g.scope === grant.scope),
  );
  filtered.push(grant);
  return filtered;
}

export function upsertApprovalGrant(projectDir: string, grant: ApprovalGrant): void {
  mutateApprovalsStore(projectDir, (store) => {
    const merged = mergeGrant(store.grants, grant);
    if (merged === null) return null;
    return { version: 1, grants: merged };
  });
}

function compactTierOverrides(rawTiers: ApprovalTierOverrides | undefined): TierMap | undefined {
  if (!rawTiers) return undefined;
  const tierOverrides: TierMap = {};
  for (const [key, tier] of Object.entries(rawTiers)) {
    const actionClass = ActionClassSchema.safeParse(key);
    if (actionClass.success && tier !== undefined) {
      tierOverrides[actionClass.data] = tier;
    }
  }
  return Object.keys(tierOverrides).length > 0 ? tierOverrides : undefined;
}

type ApprovalEventBase = {
  bus: EventBus;
  phase: Phase;
  tier: ApprovalTier;
  actionClass: ActionClass;
  taskId?: TaskId | undefined;
};

function publishApprovalRejected(args: ApprovalEventBase & { reason: string }): void {
  const { bus, phase, tier, actionClass, taskId, reason } = args;
  bus.publish({
    type: 'approval_rejected',
    ts: Date.now(),
    phase,
    tier,
    actionClass,
    ...(taskId !== undefined && { taskId }),
    reason,
  });
}

function publishApprovalGranted(
  args: ApprovalEventBase & {
    scope: 'once' | 'session' | 'always';
    confirmReason?: string | undefined;
  },
): void {
  const { bus, phase, tier, actionClass, taskId, scope, confirmReason } = args;
  bus.publish({
    type: 'approval_granted',
    ts: Date.now(),
    phase,
    tier,
    actionClass,
    ...(taskId !== undefined && { taskId }),
    scope,
    ...(confirmReason !== undefined && { confirmReason }),
  });
}

export async function gateAction(input: GateActionInput): Promise<GateDecision> {
  const {
    actionDescription,
    task,
    dependsOnFiles,
    projectDir,
    sessionId,
    phase,
    taskId,
    bus,
    callbacks,
    config,
    getApprovalEnabled,
  } = input;

  if ((getApprovalEnabled ? getApprovalEnabled() : config.approval?.enabled !== false) === false) {
    return { allow: true };
  }

  const tierOverrides = compactTierOverrides(config.approval?.tiers);
  const { actionClass, tier } = classifyAction(
    {
      actionDescription,
      taskFile: task.file,
      taskInBounds: taskScopePatterns(task),
      dependsOnFiles,
      projectDir,
      allowedPaths: config.approval?.allowedPaths,
    },
    tierOverrides,
  );

  if (tier === 'auto') {
    return { allow: true };
  }

  const request: TieredApprovalRequest = {
    tier,
    actionClass,
    actionDescription,
    phase,
    ...(taskId !== undefined && { taskId }),
  };

  if (tier === 'sticky') {
    const grants = input.grants ?? readApprovalsStore(projectDir).grants;
    const classifyContext = {
      actionDescription,
      taskFile: task.file,
      taskInBounds: taskScopePatterns(task),
      dependsOnFiles,
      projectDir,
    };
    const grantPattern = extractActionPattern(classifyContext);

    const alwaysGrant = grants.find(
      (g) =>
        g.class === actionClass &&
        g.scope === 'always' &&
        (g.pattern === actionDescription || matchesActionPattern(grantPattern, g.pattern)),
    );
    if (alwaysGrant) {
      publishApprovalGranted({ bus, phase, tier, actionClass, taskId, scope: 'always' });
      return { allow: true };
    }

    const sessionGrant = grants.find(
      (g) =>
        g.class === actionClass &&
        g.scope === 'session' &&
        g.sessionId === sessionId &&
        (g.pattern === actionDescription || matchesActionPattern(grantPattern, g.pattern)),
    );
    if (sessionGrant) {
      publishApprovalGranted({ bus, phase, tier, actionClass, taskId, scope: 'session' });
      return { allow: true };
    }

    bus.publish({
      type: 'approval_prompted',
      ts: Date.now(),
      phase,
      tier,
      actionClass,
      ...(taskId !== undefined && { taskId }),
    });

    if (!callbacks.onTieredApproval || isConfiguredHeadless(config)) {
      publishApprovalRejected({
        bus,
        phase,
        tier,
        actionClass,
        taskId,
        reason: 'APPROVAL_REQUIRED',
      });
      return { allow: false, reason: 'APPROVAL_REQUIRED', tier, actionClass, actionDescription };
    }

    const response = await callbacks.onTieredApproval(request);

    if (response.decision === 'deny') {
      publishApprovalRejected({ bus, phase, tier, actionClass, taskId, reason: response.reason });
      return { allow: false, reason: response.reason, tier, actionClass, actionDescription };
    }

    if (response.decision === 'allow') {
      if (response.scope === 'session' || response.scope === 'always') {
        const grant: ApprovalGrant = {
          pattern: grantPattern,
          class: actionClass,
          scope: response.scope,
          sessionId: response.scope === 'session' ? sessionId : undefined,
          grantedAt: nowIso(),
        };
        upsertApprovalGrant(projectDir, grant);
        if (input.grants) {
          const merged = mergeGrant(input.grants, grant);
          if (merged !== null) {
            input.grants.length = 0;
            input.grants.push(...merged);
          }
        }
        bus.publish({
          type: 'approval_sticky_recorded',
          ts: Date.now(),
          phase,
          pattern: grantPattern,
          scope: response.scope,
          actionClass,
        });
        publishApprovalGranted({ bus, phase, tier, actionClass, taskId, scope: response.scope });
        return { allow: true };
      }
      publishApprovalGranted({ bus, phase, tier, actionClass, taskId, scope: 'once' });
      return { allow: true };
    }

    publishApprovalRejected({
      bus,
      phase,
      tier,
      actionClass,
      taskId,
      reason: 'unexpected_confirm_on_sticky',
    });
    return {
      allow: false,
      reason: 'unexpected_confirm_on_sticky',
      tier,
      actionClass,
      actionDescription,
    };
  }

  if (tier === 'confirm') {
    bus.publish({
      type: 'approval_prompted',
      ts: Date.now(),
      phase,
      tier,
      actionClass,
      ...(taskId !== undefined && { taskId }),
    });

    if (!callbacks.onTieredApproval || isConfiguredHeadless(config)) {
      publishApprovalRejected({
        bus,
        phase,
        tier,
        actionClass,
        taskId,
        reason: 'APPROVAL_REQUIRED',
      });
      return { allow: false, reason: 'APPROVAL_REQUIRED', tier, actionClass, actionDescription };
    }

    const response = await callbacks.onTieredApproval(request);

    if (response.decision === 'confirm') {
      if (response.phrase !== CONFIRM_PHRASE || !response.reason) {
        publishApprovalRejected({
          bus,
          phase,
          tier,
          actionClass,
          taskId,
          reason: 'invalid_confirm_phrase',
        });
        return {
          allow: false,
          reason: 'invalid_confirm_phrase',
          tier,
          actionClass,
          actionDescription,
        };
      }
      publishApprovalGranted({
        bus,
        phase,
        tier,
        actionClass,
        taskId,
        scope: 'once',
        confirmReason: response.reason,
      });
      return {
        allow: true,
        tier,
        actionClass,
        actionDescription,
        confirmReason: response.reason,
        confirmApprovals: [{ tier, actionClass, actionDescription, reason: response.reason }],
      };
    }

    if (response.decision === 'deny') {
      publishApprovalRejected({ bus, phase, tier, actionClass, taskId, reason: response.reason });
      return { allow: false, reason: response.reason, tier, actionClass, actionDescription };
    }

    publishApprovalRejected({
      bus,
      phase,
      tier,
      actionClass,
      taskId,
      reason: 'invalid_confirm_response',
    });
    return {
      allow: false,
      reason: 'invalid_confirm_response',
      tier,
      actionClass,
      actionDescription,
    };
  }

  tier satisfies never;
  throw error('approval-tier-unknown', 'unreachable: unknown approval tier');
}
