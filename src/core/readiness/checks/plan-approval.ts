import { resolveApproveLevel, resolveEffortLevel } from '../../config/runtime/resolve.js';
import { DEFAULT_LOCAL_RETRIES } from '../../pipeline-spec/retries.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';

export function planApprovalCopy(
  config: Config,
  interaction: 'interactive' | 'headless' | undefined,
): Pick<ReadinessCheck, 'summary' | 'details'> {
  const approve = resolveApproveLevel(config);
  return {
    summary:
      approve === 'plan'
        ? 'Plan approval: you approve the plan in the TUI.'
        : 'Plan approval: automatic.',
    details:
      approve === 'plan' && interaction === 'headless'
        ? ['Headless runs approve the plan automatically because there is no approval prompt.']
        : [],
  };
}

export function buildPlanApprovalChecks(
  config: Config,
  interaction: 'interactive' | 'headless' | undefined,
): ReadinessCheck[] {
  const approve = resolveApproveLevel(config);
  const effort = resolveEffortLevel({ config });
  const approval = planApprovalCopy(config, interaction);
  return [
    {
      id: 'workflow.plan-approval',
      severity: 'info',
      summary: approval.summary,
      details: [
        ...(approval.details ?? []),
        `Retries: ${DEFAULT_LOCAL_RETRIES}`,
        `Planner effort: ${effort ?? 'provider default'}`,
      ],
      metadata: {
        approve,
        maxRetries: DEFAULT_LOCAL_RETRIES,
        effort: effort ?? null,
      },
    },
  ];
}
