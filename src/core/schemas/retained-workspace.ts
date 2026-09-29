import { z } from 'zod';
import { ChangedFilesSnapshotSchema } from './workflow.js';

export const WorkspaceOwnerSchema = z.object({
  taskId: z.string(),
  contract: z.string(),
  attempt: z.number().int().nonnegative(),
  buildSeat: z.string(),
});
export type WorkspaceOwner = z.infer<typeof WorkspaceOwnerSchema>;

const DirectoryIdentitySchema = z.object({
  dev: z.number(),
  ino: z.number(),
  birthtimeMs: z.number(),
});
export const StagedWorkspaceLeafSchema = z.string().regex(/^stage-[a-f0-9]{32}$/);

export const RetainedWorkspaceSchema = z.object({
  version: z.literal(1),
  retained: z.boolean(),
  projectDir: z.string(),
  sessionId: z.string(),
  owner: WorkspaceOwnerSchema,
  location: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('staged-copy'),
      leaf: StagedWorkspaceLeafSchema,
      rootDirectory: DirectoryIdentitySchema,
    }),
    z.object({ kind: z.literal('worktree') }),
  ]),
  directory: DirectoryIdentitySchema,
  snapshot: ChangedFilesSnapshotSchema,
  targetFiles: z.record(
    z.string(),
    z.object({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      mode: z.number().int().min(0).max(0o777),
    }),
  ),
});
export type RetainedWorkspace = z.infer<typeof RetainedWorkspaceSchema>;
