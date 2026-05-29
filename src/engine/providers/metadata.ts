import type { TokenDelta } from '../../core/schemas/tokens.js';
import { narrowRecord } from '../../utils/type-guards.js';

export function perTokenToPerMillion(perToken: number): number {
  return perToken * 1_000_000;
}

export function parsePartialUsage(value: unknown): Partial<TokenDelta> {
  const usage = narrowRecord(value);
  if (usage === null) return {};

  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  const cacheReadTokens =
    typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined;
  const cacheCreateTokens =
    typeof usage.cache_creation_input_tokens === 'number'
      ? usage.cache_creation_input_tokens
      : undefined;

  return {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheCreateTokens !== undefined && { cacheCreateTokens }),
  };
}

export function isModelFree(input?: number, output?: number): boolean {
  return (input ?? 0) === 0 && (output ?? 0) === 0;
}

export interface PricingFields {
  pricingInput?: number;
  pricingOutput?: number;
  isFree?: boolean;
}

export function pricingFieldsFromResolved(
  pricingInput?: number,
  pricingOutput?: number,
  isFree?: boolean,
): PricingFields {
  return {
    ...(pricingInput !== undefined && { pricingInput }),
    ...(pricingOutput !== undefined && { pricingOutput }),
    ...(isFree !== undefined && { isFree }),
  };
}

export function buildPricingFields(inputPerToken?: number, outputPerToken?: number): PricingFields {
  const pricingInput =
    inputPerToken !== undefined ? perTokenToPerMillion(inputPerToken) : undefined;
  const pricingOutput =
    outputPerToken !== undefined ? perTokenToPerMillion(outputPerToken) : undefined;
  const hasPricing = pricingInput !== undefined || pricingOutput !== undefined;
  return pricingFieldsFromResolved(
    pricingInput,
    pricingOutput,
    hasPricing ? isModelFree(pricingInput, pricingOutput) : undefined,
  );
}
