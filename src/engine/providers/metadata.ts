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
