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

export function formatPrice(perMillion: number | undefined): string {
  if (perMillion === undefined) return '';
  if (perMillion === 0) return 'FREE';
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}/1M`;
  if (perMillion < 1) return `$${perMillion.toFixed(2)}/1M`;
  return `$${perMillion.toFixed(perMillion % 1 === 0 ? 0 : 1)}/1M`;
}
