import type { Task, WorkflowState } from '../../../core/types/state-actions.js';
import type { ApiImplementerConfig, Config } from '../../../core/types/config-options.js';
import { hasApiBase } from '../../../core/config/accessors/runner-config.js';
import { createTextHandler, emitWarning, emitEscalate } from '../events.js';
import { createImplementer } from '../../runners/factory.js';
import type { Implementer } from '../../implementers/types.js';
import { getProviderBaseURL } from '../../../core/providers/catalog.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { runRetryStep, type EscalationContext, type RetryStepOutcome } from './step.js';

export async function runTier0Intermediate(
  ctx: EscalationContext, initialTask: Task, state: WorkflowState, lastError: string, priorAttempts: number,
): Promise<RetryStepOutcome> {
  const escalation = ctx.config.escalation;
  if (!escalation?.intermediateProvider || escalation.enabled === false) {
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  const attempts = priorAttempts + 1;
  const textHandler = createTextHandler(ctx.callbacks);

  emitEscalate(ctx.callbacks, 0, undefined, escalation.intermediateProvider, escalation.intermediateModel ?? ctx.config.implementer.model);

  const resolvedApiBase = getProviderBaseURL(escalation.intermediateProvider);
  if (!resolvedApiBase) {
    emitWarning(ctx.callbacks, `Unknown intermediate provider "${escalation.intermediateProvider}" — falling back to current implementer endpoint`);
  }

  const currentApiBase = hasApiBase(ctx.config.implementer) ? ctx.config.implementer.apiBase : undefined;
  const effectiveApiBase = resolvedApiBase || currentApiBase;
  if (!effectiveApiBase) {
    emitWarning(ctx.callbacks, `Cannot escalate: no API base URL available for intermediate provider "${escalation.intermediateProvider}"`);
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  const intermediateImplConfig: ApiImplementerConfig = {
    kind: 'api',
    provider: escalation.intermediateProvider,
    model: escalation.intermediateModel ?? ctx.config.implementer.model,
    apiBase: effectiveApiBase,
    contextLength: ctx.config.implementer.contextLength,
    temperature: ctx.config.implementer.temperature,
    timeout: ctx.config.implementer.timeout,
    customModels: ctx.config.implementer.customModels,
  };

  const intermediateConfig: Config = {
    ...ctx.config,
    implementer: intermediateImplConfig,
  };

  let intermediateImplementer: Implementer;
  try {
    intermediateImplementer = createImplementer(intermediateConfig);
  } catch (err) {
    emitWarning(ctx.callbacks, `Intermediate provider failed to initialize: ${toErrorMessage(err)}`);
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  // Intermediate provider is implementer-class (cheap API), not planner-class.
  // Recording as 'implementer' avoids ~35x cost overstatement that occurs when
  // escalation tokens are priced at planner rates (e.g., DeepSeek $0.28 vs Claude $5).
  return runRetryStep({
    ctx, task: initialTask, state, lastError, attempts,
    method: 'escalated-intermediate', transitionType: 'VALIDATION_PASS',
    commitSuffix: 'intermediate',
    usageCategory: 'implementer',
    retryFailureFallback: 'Intermediate escalation failed',
    invokeRetry: async ({ task: t, lastError: err, attempts: a }) =>
      intermediateImplementer.retry({
        task: t, projectDir: ctx.projectDir, config: intermediateConfig, context: ctx.context,
        error: err, attempt: a, kind: 'local',
        onOutput: textHandler, onEvent: ctx.callbacks.onEvent,
      }),
  });
}
