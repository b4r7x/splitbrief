import {
  resolveApproveLevel,
  resolveEffortLevel,
  resolveMode,
} from '../../config/runtime/resolve.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';

export function buildModeChecks(config: Config): ReadinessCheck[] {
  const mode = resolveMode({ config });
  const approve = resolveApproveLevel({ mode, configApprove: config.workflow.approve });
  const effort = resolveEffortLevel({ config });
  return [
    {
      id: 'mode.resolved',
      severity: 'info',
      summary: `Mode ${mode}; approval ${approve}.`,
      details: [
        `Retries: ${config.workflow.maxRetries}`,
        `Planner effort: ${effort ?? 'provider default'}`,
      ],
      metadata: {
        mode,
        approve,
        maxRetries: config.workflow.maxRetries,
        effort: effort ?? null,
      },
    },
  ];
}
