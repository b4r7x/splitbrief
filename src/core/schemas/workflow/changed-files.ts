import { z } from 'zod';

export const ChangedFilesSnapshotSchema = z.object({
  head: z.string(),
  files: z.array(z.string()),
  dirtyFileContents: z.record(z.string(), z.string().nullable()),
  // Fresh snapshots retain exact bytes and modes; legacy text snapshots still load.
  dirtyFileEntries: z
    .record(
      z.string(),
      z
        .object({
          base64: z.string(),
          mode: z.number().int().min(0).max(0o777),
        })
        .nullable(),
    )
    .optional(),
  // A run workspace's dirty files by hash and mode; their bytes are in the session's entry store.
  storedDirtyEntries: z
    .record(
      z.string(),
      z
        .object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          mode: z.number().int().min(0).max(0o777),
        })
        .nullable(),
    )
    .optional(),
  gitlinks: z.array(z.string()).optional(),
  // Symlinks that stay inside the project, by path: recorded by target, never read through.
  symlinks: z.record(z.string(), z.string()).optional(),
  baselineFileHashes: z.record(z.string(), z.string().nullable()).optional(),
  baselineFileModes: z.record(z.string(), z.number().int().min(0).max(0o777)).optional(),
  ignoreProjectDir: z.string().optional(),
  /** Paths the task changed before returning control; later checkout edits do not grant restore authority. */
  restoreFiles: z.array(z.string()).optional(),
});

export type ChangedFilesSnapshot = z.infer<typeof ChangedFilesSnapshotSchema>;

export const ChangedFilesBaselineSchema = z.object({
  head: z.string().nullable(),
  fingerprints: z.record(z.string(), z.string()),
  runStartChangedFiles: z.array(z.string()).optional(),
  activeTaskSnapshot: ChangedFilesSnapshotSchema.optional(),
});
export type PersistedChangedFilesBaseline = z.infer<typeof ChangedFilesBaselineSchema>;
