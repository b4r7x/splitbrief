import { z } from 'zod';
import { DIPTYCH_DIR } from '../paths.js';

export const CodebaseConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    tokenBudget: z.number().int().positive().max(50_000).default(4000),
    cacheDir: z.string().default(DIPTYCH_DIR),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  })
  .strict();
