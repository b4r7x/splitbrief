import { z } from 'zod';

export const SnapshotPhaseSchema = z.enum(['planning', 'implementing', 'reviewing', 'manual']);
export type SnapshotPhase = z.infer<typeof SnapshotPhaseSchema>;

export const SnapshotFileEntrySchema = z.object({
  path: z.string(),
  hash: z.string(),
  encodedName: z.string(),
  // Manifests written before modes were recorded have none.
  mode: z.number().int().nonnegative().optional(),
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
  symlinks: z.array(z.object({ path: z.string(), target: z.string() })).optional(),
  trackedFileCount: z.number().nonnegative(),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export const RunSnapshotKindSchema = z.enum([
  'pre-task',
  'post-task',
  'pre-final-review',
  'accepted-run',
]);
export type RunSnapshotKind = z.infer<typeof RunSnapshotKindSchema>;

export const RunSnapshotLedgerSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  runSnapshotIds: z.array(z.string()),
  runSnapshotKinds: z.record(z.string(), RunSnapshotKindSchema).optional(),
  accepted: z.boolean(),
  rejected: z.boolean(),
  /**
   * What the rejects of this run put back: every path restored or removed; `removed` is the part
   * of `restored` the run had created. Absent before a reject.
   */
  putBack: z.object({ restored: z.array(z.string()), removed: z.array(z.string()) }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunSnapshotLedger = z.infer<typeof RunSnapshotLedgerSchema>;
