export function perTokenToPerMillion(perToken: number): number {
  return perToken * 1_000_000;
}

export function isModelFree(input?: number, output?: number): boolean {
  return (input ?? 0) === 0 && (output ?? 0) === 0;
}

export interface PricingFields {
  pricingInput?: number;
  pricingOutput?: number;
  isFree?: boolean;
}

export function buildPricingFields(inputPerToken?: number, outputPerToken?: number): PricingFields {
  const pricingInput = inputPerToken !== undefined ? perTokenToPerMillion(inputPerToken) : undefined;
  const pricingOutput = outputPerToken !== undefined ? perTokenToPerMillion(outputPerToken) : undefined;
  const hasPricing = pricingInput !== undefined || pricingOutput !== undefined;
  return {
    ...(pricingInput !== undefined && { pricingInput }),
    ...(pricingOutput !== undefined && { pricingOutput }),
    ...(hasPricing && { isFree: isModelFree(pricingInput, pricingOutput) }),
  };
}
