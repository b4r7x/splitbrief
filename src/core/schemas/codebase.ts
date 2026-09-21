import { z } from 'zod';

export const CodebaseConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  tokenBudget: z.number().int().positive().max(50_000).default(4000),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});
