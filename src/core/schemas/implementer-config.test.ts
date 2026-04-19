import { describe, expect, it } from 'vitest';
import { ImplementerConfigSchema } from './implementer-config.js';

// `ImplementerConfigSchema = createRunnerConfigSchema(GenerationCommonFields)`.
// The generic discriminated-union behaviour (all 5 kinds parse minimally,
// unknown kinds rejected, strict() rejects extras, optional-model override
// works) is covered once in `runner-fields.test.ts`. The only implementer-
// specific delta over planner is that `model` is required (planner overrides
// it to optional in `planner-config.ts`).
describe('ImplementerConfigSchema', () => {
  it('requires model — that is the contract distinction from planner', () => {
    const withoutModel = ImplementerConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
    });
    expect(withoutModel.success).toBe(false);

    const withModel = ImplementerConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
    });
    expect(withModel.success).toBe(true);
  });
});
