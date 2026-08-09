import type { ApprovalGrant } from '../../../core/schemas/approval-store.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import { extractActionPattern, matchesActionPattern } from './action-classifier.js';
import { readApprovalsStore, mutateApprovalsStore } from '../../../core/approval/store.js';
import { nowIso } from '../../../utils/format-time.js';
import {
  publishApprovalGranted,
  publishApprovalPrompted,
  publishApprovalRejected,
} from './events.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import { taskScopePatterns } from '../task-scope.js';
import { isConfiguredHeadless, type GateActionInput, type GateDecision } from './types.js';

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

export type StickyTierInput = {
  input: GateActionInput;
  request: TieredApprovalRequest;
  actionClass: ActionClass;
};

export async function gateStickyTier(args: StickyTierInput): Promise<GateDecision> {
  const { input, request, actionClass } = args;
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
  } = input;
  const tier = 'sticky' as const;

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

  publishApprovalPrompted({ bus, phase, tier, actionClass, taskId });

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
