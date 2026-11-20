import { z } from 'zod';
import { mapRecord, narrowRecord } from '../../utils/type-guards.js';

export const ModelsDevModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    family: z.string().optional(),
    description: z.string().optional(),
    limit: z
      .object({
        context: z.number().optional(),
        input: z.number().optional(),
        output: z.number().optional(),
      })
      .passthrough()
      .optional(),
    attachment: z.boolean().optional(),
    temperature: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    open_weights: z.boolean().optional(),
    knowledge: z.string().optional(),
    status: z.string().optional(),
    modalities: z
      .object({
        input: z.array(z.string()).optional(),
        output: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    release_date: z.string().optional(),
    last_updated: z.string().optional(),
    reasoning_options: z
      .array(
        z
          .object({
            type: z.string(),
            // A non-string is not a rung: models.dev ships `[null, 'low', 'medium', 'high']`
            // on sarvam-105b/-30b (`curl -s https://models.dev/api.json`, 2026-09-05), and
            // one bad element must not fail the whole catalog.
            values: z
              .array(z.unknown())
              .transform((entries) => entries.filter((entry) => typeof entry === 'string'))
              .optional(),
            min: z.number().optional(),
            max: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()
  .transform(({ cost: _cost, ...model }) => {
    const experimental = narrowRecord(model.experimental);
    if (experimental === null) return model;
    const modes = narrowRecord(experimental.modes);
    if (modes === null) return model;

    return {
      ...model,
      experimental: {
        ...experimental,
        modes: mapRecord(modes, (value) => {
          const mode = narrowRecord(value);
          if (mode === null) return value;
          const { cost: _modeCost, ...metadata } = mode;
          return metadata;
        }),
      },
    };
  });
export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;

export const ModelsDevProviderSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    models: z.record(z.string(), ModelsDevModelSchema),
  })
  .passthrough();

export const ModelsDevCatalogSchema = z.record(z.string(), ModelsDevProviderSchema);
export type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;
