import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import {
  publishApprovalGranted,
  publishApprovalPrompted,
  publishApprovalRejected,
} from './events.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { GateActionInput, GateDecision } from './types.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import type { Plan } from '../../../core/schemas/plan.js';
import { protectedWriteClass } from './action-classifier.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { checkRegistry } from '../validation/run-checks.js';

/** A confirmation the run already granted holds for the same path and operation. */
function confirmedEarlierInRun(input: GateActionInput, actionClass: ActionClass): boolean {
  const approvals = readEvidenceLedger(input)?.approvals ?? [];
  return approvals.some(
    (approval) =>
      approval.actionClass === actionClass &&
      approval.actionDescription === input.actionDescription,
  );
}

function npmScriptConfirmations(
  checks: Iterable<Check>,
): NonNullable<GateDecision['confirmApprovals']> {
  return [...checks].flatMap((check) => {
    if (check.kind !== 'cmd') return [];
    const [token, sub, script] = parseShellCommand(check.value);
    const cmd = token?.toLowerCase().replace(/@[^@]*$/, '');
    if (cmd !== 'npm' || sub !== 'run' || script === undefined) return [];
    return [
      {
        tier: 'confirm' as const,
        actionClass: 'validation' as const,
        actionDescription: check.value,
        reason: 'check on the approved plan',
      },
    ];
  });
}

/**
 * The protected writes an approved plan lists, as the confirmations `confirmedEarlierInRun` reads:
 * the same ActionClass and `write <path>` the write gate asks about. The plan's run-level checks
 * join the task checks, so an approved `npm run` check on the plan is confirmed too.
 */
export function planConfirmations(
  tasks: readonly Task[],
  projectDir: string,
  plan?: Plan,
): NonNullable<GateDecision['confirmApprovals']> {
  const protectedWrites = tasks.flatMap((task) =>
    (task.protectedOperations ?? []).flatMap((operation) => {
      const actionClass = protectedWriteClass(operation.path, projectDir);
      return actionClass === null
        ? []
        : [
            {
              tier: 'confirm' as const,
              actionClass,
              actionDescription: `write ${operation.path}`,
              reason: 'listed on the approved plan',
            },
          ];
    }),
  );
  return [...protectedWrites, ...npmScriptConfirmations(checkRegistry({ tasks, plan }).values())];
}

export type ConfirmTierInput = {
  input: GateActionInput;
  request: TieredApprovalRequest;
  actionClass: ActionClass;
};

export async function gateConfirmTier(args: ConfirmTierInput): Promise<GateDecision> {
  const { input, request, actionClass } = args;
  const { actionDescription, phase, taskId, bus, callbacks } = input;
  const tier = 'confirm' as const;

  if (confirmedEarlierInRun(input, actionClass)) {
    publishApprovalGranted({ bus, phase, tier, actionClass, taskId, scope: 'session' });
    return { allow: true };
  }

  publishApprovalPrompted({ bus, phase, tier, actionClass, taskId });

  if (!callbacks.onTieredApproval) {
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

  publishApprovalRejected({ bus, phase, tier, actionClass, taskId, reason: response.reason });
  return { allow: false, reason: response.reason, tier, actionClass, actionDescription };
}
