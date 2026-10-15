import { resolveApproveLevel } from '../../config/runtime/resolve.js';
import { DEFAULT_LOCAL_RETRIES } from '../../pipeline-spec/retries.js';
import { CREW_SEAT_LABELS } from '../../crew/identity.js';
import type { Config } from '../../schemas/config.js';
import { countNoun } from '../../../utils/pluralize.js';
import type { ReadinessCheck } from '../types.js';

export function buildPlanApprovalChecks(
  config: Config,
  interaction: 'interactive' | 'headless' | undefined,
): ReadinessCheck[] {
  const approve = resolveApproveLevel(config);
  return [
    {
      id: 'workflow.plan-approval',
      severity: 'info',
      summary:
        approve === 'plan'
          ? 'Plan approval: you approve the plan in the TUI.'
          : 'Plan approval: automatic.',
      ...(approve === 'plan' &&
        interaction === 'headless' && {
          details: [
            'Headless runs approve the plan automatically because there is no approval prompt.',
          ],
        }),
      metadata: { approve },
    },
    {
      id: 'workflow.retries',
      severity: 'info',
      summary: `${CREW_SEAT_LABELS.build} gets ${countNoun(DEFAULT_LOCAL_RETRIES, 'retry', 'retries')} after a failed check, then asks ${CREW_SEAT_LABELS.plan} or ${CREW_SEAT_LABELS.review} for guidance.`,
      metadata: { maxRetries: DEFAULT_LOCAL_RETRIES },
    },
  ];
}
