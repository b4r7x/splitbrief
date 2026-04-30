import { z } from 'zod';

export const CassetteEntrySchema = z.object({
  index: z.number(),
  recordedAt: z.string(),
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.union([z.string(), z.null()]),
  }),
  response: z.object({
    status: z.number(),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
  }),
  provider: z.string(),
  durationMs: z.number(),
});

export const CassetteSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  recordedAt: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  entries: z.array(CassetteEntrySchema),
});

export type CassetteEntry = z.infer<typeof CassetteEntrySchema>;
export type Cassette = z.infer<typeof CassetteSchema>;
