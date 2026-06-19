import { z } from 'zod';

const ModelsDevCostFieldsSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
});

export const ModelsDevCostTierSchema = ModelsDevCostFieldsSchema.extend({
  tier: z
    .object({
      type: z.unknown().optional(),
      size: z.unknown().optional(),
    })
    .optional(),
});

export const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cost: z
    .object({
      ...ModelsDevCostFieldsSchema.shape,
      tiers: z.array(ModelsDevCostTierSchema).optional(),
      context_over_200k: ModelsDevCostFieldsSchema.optional(),
    })
    .optional(),
  limit: z
    .object({
      context: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
  temperature: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  modalities: z
    .object({
      input: z.array(z.string()).optional(),
      output: z.array(z.string()).optional(),
    })
    .optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
});
export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;

export const ModelsDevProviderSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  models: z.record(z.string(), ModelsDevModelSchema),
});

export const ModelsDevCatalogSchema = z.record(z.string(), ModelsDevProviderSchema);
export type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;
