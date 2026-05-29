import { z } from 'zod';

export const OtelConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    serviceName: z.string().default('diptych'),
  })
  .strict();
