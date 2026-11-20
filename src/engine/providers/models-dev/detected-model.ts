import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import type { ModelsDevModel } from '../../../core/schemas/models-dev.js';

/**
 * models.dev publishes the ladder as options, not as a list. Only an `effort` entry names
 * rungs; `budget_tokens` is a token budget and `toggle` is a boolean, and neither names a
 * level. Scored against `opencode models --verbose` (opencode 1.18.15, capture of
 * 2026-09-04) over all 73 models it serves: these two arms agree with the tool on more rows
 * than a `toggle -> none|thinking` third arm on every census — 51 vs 42 against the
 * models.dev catalog of 2026-09-05, and the counts move with that catalog.
 */
function reasoningEffortsOf(options: ModelsDevModel['reasoning_options']): string[] | undefined {
  if (options === undefined) return undefined;
  const effort = options.find((option) => option.type === 'effort');
  return effort?.values === undefined ? [] : [...effort.values];
}

export function modelToDetected(providerId: string, model: ModelsDevModel): DetectedModel {
  const result: DetectedModel = {
    id: model.id,
    providerId,
    modelId: model.id,
  };

  if (model.name !== undefined) {
    result.displayName = model.name;
  }

  if (model.status !== undefined) {
    result.lifecycle = model.status;
  }

  if (model.limit?.context !== undefined) {
    result.contextLength = model.limit.context;
    result.maximumContextTokens = model.limit.context;
  }

  if (model.limit?.input !== undefined) {
    result.maximumInputTokens = model.limit.input;
  }

  if (model.limit?.output !== undefined) {
    result.maxOutputTokens = model.limit.output;
    result.maximumOutputTokens = model.limit.output;
  }

  if (model.temperature !== undefined) {
    result.supportsTemperature = model.temperature;
  }

  if (model.reasoning !== undefined) {
    result.supportsReasoning = model.reasoning;
  }

  const imageInput = model.modalities?.input?.includes('image');
  if (imageInput !== undefined) {
    result.supportsImages = imageInput;
  }

  if (model.modalities?.input !== undefined) {
    result.inputModalities = [...model.modalities.input];
  }

  if (model.modalities?.output !== undefined) {
    result.outputModalities = [...model.modalities.output];
  }

  if (model.tool_call !== undefined) {
    result.supportsToolCalls = model.tool_call;
  }

  if (model.structured_output !== undefined) {
    result.supportsStructuredOutput = model.structured_output;
  }

  if (model.release_date !== undefined) {
    result.releaseDate = model.release_date;
  }

  if (model.last_updated !== undefined) {
    result.updatedDate = model.last_updated;
  }

  const reasoningEfforts = reasoningEffortsOf(model.reasoning_options);
  if (reasoningEfforts !== undefined) {
    result.nativeReasoningEfforts = reasoningEfforts;
  }

  return result;
}

export function mergeDetectedModel(
  current: DetectedModel | undefined,
  incoming: DetectedModel,
): DetectedModel {
  if (!current) return incoming;
  const contextLength = incoming.contextLength ?? current.contextLength;
  const maxOutputTokens = incoming.maxOutputTokens ?? current.maxOutputTokens;
  const supportsTemperature = incoming.supportsTemperature ?? current.supportsTemperature;
  const supportsReasoning = incoming.supportsReasoning ?? current.supportsReasoning;
  const supportsImages = incoming.supportsImages ?? current.supportsImages;
  const providerId = incoming.providerId ?? current.providerId;
  const modelId = incoming.modelId ?? current.modelId;
  const displayName = incoming.displayName ?? current.displayName;
  const lifecycle = incoming.lifecycle ?? current.lifecycle;
  const releaseDate = incoming.releaseDate ?? current.releaseDate;
  const updatedDate = incoming.updatedDate ?? current.updatedDate;
  const maximumContextTokens = incoming.maximumContextTokens ?? current.maximumContextTokens;
  const effectiveContextTokens = incoming.effectiveContextTokens ?? current.effectiveContextTokens;
  const maximumInputTokens = incoming.maximumInputTokens ?? current.maximumInputTokens;
  const maximumOutputTokens = incoming.maximumOutputTokens ?? current.maximumOutputTokens;
  const inputModalities = incoming.inputModalities ?? current.inputModalities;
  const nativeReasoningEfforts = incoming.nativeReasoningEfforts ?? current.nativeReasoningEfforts;
  const outputModalities = incoming.outputModalities ?? current.outputModalities;
  const supportsToolCalls = incoming.supportsToolCalls ?? current.supportsToolCalls;
  const supportsStructuredOutput =
    incoming.supportsStructuredOutput ?? current.supportsStructuredOutput;
  const capabilities = incoming.capabilities ?? current.capabilities;
  return {
    ...current,
    ...incoming,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(lifecycle !== undefined ? { lifecycle } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(supportsTemperature !== undefined ? { supportsTemperature } : {}),
    ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
    ...(supportsImages !== undefined ? { supportsImages } : {}),
    ...(releaseDate !== undefined ? { releaseDate } : {}),
    ...(updatedDate !== undefined ? { updatedDate } : {}),
    ...(maximumContextTokens !== undefined ? { maximumContextTokens } : {}),
    ...(effectiveContextTokens !== undefined ? { effectiveContextTokens } : {}),
    ...(maximumInputTokens !== undefined ? { maximumInputTokens } : {}),
    ...(maximumOutputTokens !== undefined ? { maximumOutputTokens } : {}),
    ...(inputModalities !== undefined ? { inputModalities: [...inputModalities] } : {}),
    ...(nativeReasoningEfforts !== undefined
      ? { nativeReasoningEfforts: [...nativeReasoningEfforts] }
      : {}),
    ...(outputModalities !== undefined ? { outputModalities: [...outputModalities] } : {}),
    ...(supportsToolCalls !== undefined ? { supportsToolCalls } : {}),
    ...(supportsStructuredOutput !== undefined ? { supportsStructuredOutput } : {}),
    ...(capabilities !== undefined ? { capabilities: [...capabilities] } : {}),
  };
}
