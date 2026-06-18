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
