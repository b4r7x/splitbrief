import type { ModelOption } from '../../src/features/runners/model-catalog/recency.js';
import type { RightRow } from '../../src/features/runners/model-catalog/types.js';

export function optionAxisRow(input: {
  model: ModelOption;
  axis: 'effort' | 'fast';
  value: string;
  choices?: readonly string[];
  providerPrefix?: string;
  last?: boolean;
  steps?: boolean;
}): RightRow {
  return {
    kind: 'axis',
    model: input.model,
    axis: input.axis,
    providerPrefix: input.providerPrefix ?? '',
    value: input.value,
    choices: input.choices ?? [],
    steps: input.steps ?? true,
    last: input.last ?? false,
    tree: { depth: 1, parentContinues: false },
  };
}
