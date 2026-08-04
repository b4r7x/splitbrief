import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import { missingRunnerCredential } from '../../../core/config/accessors/runner-credentials.js';
import { resolveIntermediateRunner } from '../../../core/config/accessors/intermediate-runner.js';
import { getApiProviderDescriptor } from '../../../core/providers/api-provider-catalog.js';
import { isProviderId } from '../../../core/schemas/enums.js';
import {
  findKnownModel,
  getEffectiveModelId,
  lookupModelsDevModel,
  lookupRuntimeModel,
} from '../../providers/model/resolution.js';
import type { Implementer } from '../../implementers/types.js';
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
import { error } from '../../../utils/error.js';

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
    if (ctx.createImplementer === undefined) {
      throw error('runner-gate-mismatch', 'Prepared intermediate factory is unavailable.');
    }
    intermediateImplementer = await ctx.createImplementer(intermediateConfig, {
      publisher: createImplementerPublisher(ctx.bus),
      slot: { role: 'intermediate' },
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
  const contextLength = resolveIntermediateContextLength(
    ctx,
    escalation.intermediateProvider,
    intermediateModel,
  );
  const resolved = resolveIntermediateRunner(ctx.config, { contextLength });
  if (getApiProviderDescriptor(escalation.intermediateProvider) === undefined) {
    publishWarning({
      bus: ctx.bus,
      phase: state.phase,
      message: `Unknown intermediate provider "${escalation.intermediateProvider}" — falling back to current implementer endpoint`,
    });
  }

  if (resolved === null) {
    publishWarning({
      bus: ctx.bus,
      phase: state.phase,
      message: `Cannot escalate: no API base URL available for intermediate provider "${escalation.intermediateProvider}"`,
    });
    return null;
  }

  const intermediateConfig = { ...ctx.config, implementer: resolved.runner };
  delete intermediateConfig.implementerProfiles;
  return intermediateConfig;
}
