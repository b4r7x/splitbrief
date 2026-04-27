import { z } from 'zod';

export const SnapshotPhaseSchema = z.enum([
  'planning',
  'implementing',
  'reviewing',
  'manual',
]);
export type SnapshotPhase = z.infer<typeof SnapshotPhaseSchema>;

export const SnapshotFileEntrySchema = z.object({
  path: z.string(),
  hash: z.string(),
  encodedName: z.string(),
  sizeBytes: z.number().nonnegative(),
});
export type SnapshotFileEntry = z.infer<typeof SnapshotFileEntrySchema>;

export const SnapshotManifestSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  sessionId: z.string(),
  name: z.string().optional(),
  createdAt: z.string(),
  phase: SnapshotPhaseSchema,
  taskIndex: z.number().int().nonnegative().optional(),
  fileHashes: z.record(z.string(), z.string()),
  fileEntries: z.array(SnapshotFileEntrySchema),
  trackedFileCount: z.number().nonnegative(),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;
