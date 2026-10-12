import { z } from 'zod';
import { SPLITBRIEF_DIR } from '../paths.js';

export const CodebaseConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  tokenBudget: z.number().int().positive().max(50_000).default(4000),
  cacheDir: z.string().default(SPLITBRIEF_DIR),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});
