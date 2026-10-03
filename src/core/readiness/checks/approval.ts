import { resolveApproveLevel, resolveEffortLevel } from '../../config/runtime/resolve.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';

export function buildApprovalChecks(
  config: Config,
  interaction: 'interactive' | 'headless' | undefined,
): ReadinessCheck[] {
  const approve = resolveApproveLevel(config);
  const effort = resolveEffortLevel({ config });
  return [
    {
      id: 'approval.resolved',
      severity: 'info',
      summary:
        approve === 'plan' && interaction === 'headless'
          ? 'Plan approval: plan; a headless run approves the plan card unattended.'
          : `Plan approval: ${approve}.`,
      details: [
        `Retries: ${config.workflow.maxRetries}`,
        `Planner effort: ${effort ?? 'provider default'}`,
      ],
      metadata: {
        approve,
        maxRetries: config.workflow.maxRetries,
        effort: effort ?? null,
      },
    },
  ];
}
