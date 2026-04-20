import { z } from 'zod';

export const CodebaseConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tokenBudget: z.number().int().positive().max(50_000).default(4000),
  cacheDir: z.string().default('.diptych'),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
}).strict();

export type CodebaseConfig = z.infer<typeof CodebaseConfigSchema>;
