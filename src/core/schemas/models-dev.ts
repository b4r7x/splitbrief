import { z } from 'zod';

// Flat-rate pricing only: diptych reads base `input`/`output` (per-MTok) and
// ignores models.dev tiered long-context fields (`tiers`, `context_over_200k`).
// Cost accounting applies the base rate at every context size; for models with
// higher above-threshold rates (e.g. gpt-5.4 over 272k tokens) this under-counts
// long-context spend rather than over-counting. Unknown keys are stripped by Zod.
export const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cost: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
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
