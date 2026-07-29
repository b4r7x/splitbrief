import { z } from 'zod';

export const OtelConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  serviceName: z.string().default('splitbrief'),
});
