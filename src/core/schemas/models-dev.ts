import { z } from 'zod';

export const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cost: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
  }).optional(),
  limit: z.object({
    context: z.number().optional(),
    output: z.number().optional(),
  }).optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
});
export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;

export const ModelsDevProviderSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  models: z.record(z.string(), ModelsDevModelSchema),
});
export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>;

export const ModelsDevCatalogSchema = z.record(z.string(), ModelsDevProviderSchema);
export type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;
