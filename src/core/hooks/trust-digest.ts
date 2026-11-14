import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { assertExistingPathConfined } from '../../lib/fs/confinement.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { toErrorMessage } from '../../utils/format/errors.js';
import { sha256Hex } from '../../utils/sha256.js';
import { HookEventSchema, HooksConfigSchema } from '../schemas/hooks.js';
import { commandHookPlan, repoRelativeHookPath, type HookFileDigest } from './digest-plan.js';

export function hashHooksConfig(projectDir: string, hooks: unknown): string {
  const json = canonicalJSON({
    hooks: hooks ?? null,
    commandScriptDigests: collectCommandScriptDigests(projectDir, hooks),
  });
  return `sha256:${sha256Hex(json)}`;
}

function collectCommandScriptDigests(projectDir: string, hooks: unknown): HookFileDigest[] {
  const parsed = HooksConfigSchema.safeParse(hooks);
  if (!parsed.success) return [];

  const digests: HookFileDigest[] = [];
  const seen = new Set<string>();
  for (const event of HookEventSchema.options) {
    for (const entry of parsed.data[event] ?? []) {
      if (entry.kind !== 'command') continue;
      const plan = commandHookPlan(projectDir, entry.command, entry.args);
      const candidates = [
        ...plan.files.map((file) => hashHookFile(projectDir, file)),
        ...plan.entries,
      ];
      for (const digest of candidates) {
        if (seen.has(digest.path)) continue;
        seen.add(digest.path);
        digests.push(digest);
      }
    }
  }
  return digests.toSorted((a, b) => a.path.localeCompare(b.path));
}

export type IneligibleHookTarget = {
  path: string;
  reason: string;
};

/**
 * A target the digest refuses to bind is not the same as a changed digest: dispatch runs the
 * command even when its digest entry is a refusal, so a receipt that recorded the refusal could
 * keep authorizing bytes the digest never saw when the target changes. Trust is withheld instead,
 * and no receipt is written.
 */
export function findIneligibleHookTarget(
  projectDir: string,
  hooks: unknown,
): IneligibleHookTarget | null {
  const parsed = HooksConfigSchema.safeParse(hooks);
  if (!parsed.success) return null;
  for (const event of HookEventSchema.options) {
    for (const entry of parsed.data[event] ?? []) {
      if (entry.kind !== 'command') continue;
      for (const file of commandHookPlan(projectDir, entry.command, entry.args).files) {
        const symlinkPath = symlinkedHookFile(projectDir, file);
        if (symlinkPath !== null) {
          return { path: symlinkPath, reason: 'symlink hook script' };
        }
      }
    }
  }
  return null;
}

function symlinkedHookFile(projectDir: string, hookPath: string): string | null {
  const relativePath = repoRelativeHookPath({ projectDir, path: hookPath });
  if (relativePath === null) return null;
  try {
    return lstatSync(resolve(projectDir, relativePath)).isSymbolicLink() ? relativePath : null;
  } catch {
    return null;
  }
}

function hashHookFile(projectDir: string, hookPath: string): HookFileDigest {
  const relativePath = repoRelativeHookPath({ projectDir, path: hookPath });
  if (relativePath === null) {
    return { path: hookPath, error: 'hook file path is not a confined project path' };
  }
  try {
    assertExistingPathConfined(relativePath, projectDir);
    const filePath = resolve(projectDir, relativePath);
    if (!existsSync(filePath)) {
      return { path: relativePath, error: 'file not found' };
    }
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      return { path: relativePath, error: 'symlink hook script' };
    }
    // A FIFO read waits for a writer that may never come; a socket or device is no script.
    if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
      return { path: relativePath, error: 'not a regular file' };
    }
    // The path can be swapped between the checks above and the read below, so open without
    // following symlinks and without blocking on a FIFO, then verify the opened descriptor is the
    // same regular file the lstat saw before reading the descriptor itself.
    let fd: number | null = null;
    try {
      fd = openSync(
        filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const opened = fstatSync(fd);
      if (!opened.isFile()) {
        return { path: relativePath, error: 'not a regular file' };
      }
      if (opened.dev !== st.dev || opened.ino !== st.ino) {
        return { path: relativePath, error: 'file replaced during hashing' };
      }
      const content = readFileSync(fd);
      return {
        path: relativePath,
        sha256: sha256Hex(content),
      };
    } finally {
      if (fd !== null) closeSync(fd);
    }
  } catch (err) {
    return { path: relativePath, error: toErrorMessage(err) };
  }
}
