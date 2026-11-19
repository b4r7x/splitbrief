import { join, relative } from 'node:path';
import { z } from 'zod';
import { ensureConfigGitignore } from '../../../core/config/load/document.js';
import { sessionDir } from '../../../core/paths.js';
import type { IsolationStrategy } from '../../../core/schemas/enums.js';
import { listSessions } from '../../../core/sessions/io.js';
import { checkSessionLiveness } from '../../../core/sessions/lock/file.js';
import { loadState } from '../../../core/state/persistence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { writeConfinedSecureFileAsync } from '../../../lib/fs/secure.js';
import { readHeadSha } from '../../../lib/git/repository.js';
import { error } from '../../../utils/error.js';
import { checkoutWriterRevision, hasOtherLiveCheckoutRun } from '../../checkout-writers.js';
import {
  type FileSnapshotEntry,
  readConfinedEntry,
} from '../approval/file-snapshots/entry/read.js';
import { retentionError } from './retention.js';

const SeedSchema = z.union([
  z.object({ strategy: z.literal('none') }),
  z.object({
    strategy: z.enum(['worktree', 'staged-copy']),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  }),
  z.object({
    strategy: z.enum(['worktree', 'staged-copy']),
    head: z.null(),
    writerRevision: z.number().int().nonnegative(),
    gitignore: z
      .object({
        base64: z.string(),
        mode: z.number().int().min(0).max(0o777),
      })
      .nullable()
      .optional(),
  }),
]);
type WorkspaceSeed = z.infer<typeof SeedSchema>;

function seedPath(ref: SessionRef): string {
  return relative(
    ref.projectDir,
    join(sessionDir(ref.projectDir, ref.sessionId), 'workspace-seed.json'),
  );
}

export async function readWorkspaceSeed(ref: SessionRef): Promise<WorkspaceSeed | null> {
  const entry = await readConfinedEntry(ref.projectDir, seedPath(ref));
  if (entry.kind === 'absent') return null;
  try {
    return SeedSchema.parse(JSON.parse(entry.bytes.toString('utf8')));
  } catch {
    throw retentionError.unavailable();
  }
}

function checkoutRunActive(ref: SessionRef): boolean {
  return listSessions(ref.projectDir).some(({ id }) => {
    if (id === ref.sessionId) return false;
    const status = checkSessionLiveness(sessionDir(ref.projectDir, id));
    return (
      (status.alive || status.processAlive === true) &&
      loadState({ projectDir: ref.projectDir, sessionId: id })?.workspace?.kind === 'checkout'
    );
  });
}

async function saveWorkspaceSeed<T extends WorkspaceSeed>(ref: SessionRef, seed: T): Promise<T> {
  await writeConfinedSecureFileAsync(ref.projectDir, seedPath(ref), JSON.stringify(seed));
  return seed;
}

/** Keep the starting ignore entry only when the worktree adds a rule. */
export async function ensureSeedGitignore(ref: SessionRef, worktreeDir: string): Promise<void> {
  const seed = await readWorkspaceSeed(ref);
  if (seed === null || !('writerRevision' in seed)) {
    await ensureConfigGitignore(worktreeDir);
    return;
  }
  let entry: FileSnapshotEntry | undefined;
  const changed = await ensureConfigGitignore(worktreeDir, async () => {
    entry = await readConfinedEntry(worktreeDir, '.gitignore');
  });
  if (!changed || entry === undefined) return;
  await saveWorkspaceSeed(ref, {
    ...seed,
    gitignore:
      entry.kind === 'file' ? { base64: entry.bytes.toString('base64'), mode: entry.mode } : null,
  });
}

export async function readSeedGitignore(ref: SessionRef) {
  const seed = await readWorkspaceSeed(ref);
  const gitignore = seed !== null && 'gitignore' in seed ? seed.gitignore : undefined;
  if (gitignore == null) return gitignore;
  return { bytes: Buffer.from(gitignore.base64, 'base64'), mode: gitignore.mode };
}

async function pinWorkspaceSeed(
  ref: SessionRef,
  strategy: Exclude<IsolationStrategy, 'none'>,
): Promise<Extract<WorkspaceSeed, { head: string }>> {
  const head = await readHeadSha(ref.projectDir);
  if (head === null) {
    throw error(
      'isolation-head-required',
      'Make a Git commit before starting an isolated run alongside a run in your checkout.',
    );
  }
  return saveWorkspaceSeed(ref, { strategy, head });
}

export async function reserveWorkspaceSeed(
  ref: SessionRef,
  strategy: IsolationStrategy,
): Promise<WorkspaceSeed> {
  if (strategy === 'none') return saveWorkspaceSeed(ref, { strategy });
  const writerRevision = checkoutWriterRevision(ref.projectDir);
  if (hasOtherLiveCheckoutRun(ref) || checkoutRunActive(ref))
    return pinWorkspaceSeed(ref, strategy);
  return saveWorkspaceSeed(ref, { strategy, head: null, writerRevision });
}

export async function pinSeedIfCheckoutChanged(
  ref: SessionRef,
  seed: WorkspaceSeed | null,
): Promise<Extract<WorkspaceSeed, { head: string }> | null> {
  if (seed === null || !('writerRevision' in seed)) return null;
  if (
    checkoutWriterRevision(ref.projectDir) === seed.writerRevision &&
    !hasOtherLiveCheckoutRun(ref) &&
    !checkoutRunActive(ref)
  ) {
    return null;
  }
  return pinWorkspaceSeed(ref, seed.strategy);
}
