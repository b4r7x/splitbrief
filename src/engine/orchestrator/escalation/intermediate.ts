import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ApiImplementerConfig } from '../../../core/schemas/implementer-config.js';
import { hasApiBase } from '../../../core/config/accessors/runner-config.js';
import { missingRunnerCredential } from '../../../core/config/accessors/runner-credentials.js';
import { getProviderBaseURL } from '../../../core/providers/catalog.js';
import { isProviderId } from '../../../core/schemas/enums.js';
import {
  findKnownModel,
  getEffectiveModelId,
  lookupModelsDevModel,
  lookupRuntimeModel,
} from '../../providers/model/resolution.js';
import type { Implementer } from '../../implementers/types.js';
import { createImplementer } from '../../runners/factory.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import {
  createBusTextHandler,
  createImplementerPublisher,
  publishEscalate,
  publishWarning,
  publishWarningFromError,
} from '../events.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { runRetryStep } from './step.js';
import type { EscalationContext, RetryStepOutcome, TierStepInput } from './types.js';

export async function runIntermediateTier(input: TierStepInput): Promise<RetryStepOutcome> {
  const { ctx, task: initialTask, state, lastError, priorAttempts } = input;
  const escalation = ctx.config.escalation;
  if (
    !escalation?.intermediateProvider ||
    !escalation.intermediateModel ||
    escalation.enabled === false
  ) {
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  const attempts = priorAttempts + 1;
  const textHandler = createBusTextHandler(
    { bus: ctx.bus, phase: state.phase },
    { role: 'implementer' },
  );

  const intermediateConfig = resolveIntermediateConfig(ctx, state);
  if (!intermediateConfig) return { state, task: initialTask, lastError, attempts: priorAttempts };
  const missingCredential = missingRunnerCredential(intermediateConfig.implementer);
  if (missingCredential) {
    publishWarning({
      bus: ctx.bus,
      phase: state.phase,
      message: `Cannot escalate: ${missingCredential.providerDisplayName} intermediate provider is missing ${missingCredential.envVar ?? 'an API key'}`,
    });
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  let intermediateImplementer: Implementer;
  try {
    intermediateImplementer = await createImplementer(intermediateConfig, {
      publisher: createImplementerPublisher(ctx.bus),
    });
  } catch (err) {
    publishWarningFromError(
      { bus: ctx.bus, phase: state.phase },
      'Intermediate provider failed to initialize',
      err,
    );
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  publishEscalate({
    bus: ctx.bus,
    phase: state.phase,
    taskId: initialTask.id,
    tier: 0,
    tool: escalation.intermediateProvider,
    model: escalation.intermediateModel,
  });

  return runRetryStep({
    ctx,
    task: initialTask,
    state,
    lastError,
    attempts,
    method: 'escalated-intermediate',
    transitionType: 'VALIDATION_PASS',
    commitSuffix: 'intermediate',
    usageCategory: 'implementer',
    retryFailureFallback: 'Intermediate escalation failed',
    resultTool: escalation.intermediateProvider,
    resultModel: escalation.intermediateModel,
    invokeRetry: makeImplementerRetryInvoker({
      context: ctx.context,
      kind: 'local',
      languageContext: buildProjectLanguageContext(
        ctx.projectDir,
        state.discoveredValidation?.language,
      ),
      phase: state.phase,
      onOutput: textHandler,
      implementer: intermediateImplementer,
      config: intermediateConfig,
    }),
  });
}

function resolveIntermediateContextLength(
  ctx: EscalationContext,
  provider: string,
  model: string,
): number | undefined {
  if (!isProviderId(provider)) return undefined;
  const modelId = getEffectiveModelId(provider, model);
  if (!modelId) return undefined;

  const cache = ctx.modelCache;
  if (cache) {
    const modelsDev = lookupModelsDevModel(provider, modelId, cache);
    if (modelsDev?.contextLength !== undefined) return modelsDev.contextLength;
    const runtime = lookupRuntimeModel(provider, modelId, cache);
    if (runtime?.contextLength !== undefined) return runtime.contextLength;
  }

  return findKnownModel(provider, modelId)?.contextLength;
}

export function resolveIntermediateConfig(
  ctx: EscalationContext,
  state: WorkflowState,
): Config | null {
  const escalation = ctx.config.escalation;
  if (!escalation?.intermediateProvider || !escalation.intermediateModel) return null;
  const intermediateModel = escalation.intermediateModel;
  const resolvedApiBase = getProviderBaseURL(escalation.intermediateProvider);
  if (!resolvedApiBase) {
    publishWarning({
      bus: ctx.bus,
      phase: state.phase,
      message: `Unknown intermediate provider "${escalation.intermediateProvider}" — falling back to current implementer endpoint`,
    });
  }

  const currentApiBase = hasApiBase(ctx.config.implementer)
    ? ctx.config.implementer.apiBase
    : undefined;
  const effectiveApiBase = resolvedApiBase || currentApiBase;
  if (!effectiveApiBase) {
    publishWarning({
      bus: ctx.bus,
      phase: state.phase,
      message: `Cannot escalate: no API base URL available for intermediate provider "${escalation.intermediateProvider}"`,
    });
    return null;
  }

  const contextLength = resolveIntermediateContextLength(
    ctx,
    escalation.intermediateProvider,
    intermediateModel,
  );

  const intermediateImplConfig: ApiImplementerConfig = {
    kind: 'api',
    provider: escalation.intermediateProvider,
    model: intermediateModel,
    apiBase: effectiveApiBase,
    ...(contextLength !== undefined && { contextLength }),
    timeout: ctx.config.implementer.timeout,
  };

  return {
    ...ctx.config,
    implementer: intermediateImplConfig,
  };
}
