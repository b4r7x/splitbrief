import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { getSplitbriefPath } from '../../../core/paths.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { confinedReadFileAsync, confinedUnlinkSync } from '../../../lib/fs/confined.js';
import { writeConfinedSecureFileAsync } from '../../../lib/fs/secure.js';
import { snapshotFromCache, buildCache } from './codec.js';
import {
  CACHE_FILENAME,
  type DetectionCache,
  DetectionCacheSchema,
  CACHE_RELATIVE_PATH,
  type DetectionCacheSnapshot,
  type RememberedPresentation,
  type RememberedCliRuntime,
  DEFAULT_TTL_MS,
  type SaveDetectionCacheInput,
} from './schema.js';

function cachePath(projectDir: string): string {
  return getSplitbriefPath(projectDir, CACHE_FILENAME);
}

function parseCache(value: unknown): DetectionCache | null {
  const result = DetectionCacheSchema.safeParse(value);
  return result.success ? result.data : null;
}

function isLegacyPrivateCache(value: unknown): value is Readonly<{ version: 1 | 2 }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'version' in value &&
    (value.version === 1 || value.version === 2)
  );
}

async function readCacheRaw(projectDir: string): Promise<unknown | null> {
  try {
    const raw = await confinedReadFileAsync(projectDir, CACHE_RELATIVE_PATH);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readCache(projectDir: string): Promise<DetectionCache | null> {
  const raw = await readCacheRaw(projectDir);
  if (isLegacyPrivateCache(raw)) {
    try {
      // Versions 1 and 2 persisted model inventories and diagnostics. Keep
      // the same confined unlink boundary as explicit invalidation, without
      // reading or propagating any of their private fields.
      confinedUnlinkSync(projectDir, CACHE_RELATIVE_PATH);
    } catch {
      // A cache cleanup failure is non-critical and must not bypass confinement.
    }
    return null;
  }
  return parseCache(raw);
}

/**
 * Reads a cache record only when its original non-secret context is identical
 * to the caller's current context. Disk snapshots are always stale at hydration.
 */
export async function loadDetectionCacheSnapshot(
  input: Readonly<{ projectDir: string; contextKey: string }>,
): Promise<DetectionCacheSnapshot | null> {
  const cache = await readCache(input.projectDir);
  if (cache === null || cache.contextKey !== input.contextKey) return null;
  return snapshotFromCache(cache);
}

/**
 * Reads a cache record for presentation purposes regardless of whether the
 * caller's contextKey matches the cached record. Flags `foreignContext` when
 * the contextKey differs.
 */
export async function loadRememberedPresentationSnapshot(
  input: Readonly<{ projectDir: string; contextKey: string }>,
): Promise<RememberedPresentation | null> {
  const cache = await readCache(input.projectDir);
  if (cache === null) return null;
  const snapshot = snapshotFromCache(cache);
  if (snapshot === null) return null;
  return { snapshot, foreignContext: cache.contextKey !== input.contextKey };
}

/**
 * The remembered snapshot with no discovery context to compare against: a halt
 * and a preparation both hold none — the run is stopping, or has not begun
 * probing — so the record is read for what it remembers, whatever context it
 * was probed under. Every row it yields is confirmed again before it is used.
 */
export async function loadRememberedSnapshot(
  projectDir: string,
): Promise<DetectionCacheSnapshot | null> {
  const cache = await readCache(projectDir);
  if (cache === null) return null;
  return snapshotFromCache(cache);
}

/**
 * Answers the single question a runner construction asks of the remembered
 * record: which version did the last readiness pass observe for this tool. The
 * caller holds a tool id and the executable it is about to start, never the
 * discovery context that pass ran under, so the lookup is keyed by tool alone;
 * the record's own executable fingerprint travels back with the version and
 * binds the answer to that binary instead. Records past the readiness freshness
 * bound are withheld.
 */
export async function loadRememberedCliRuntime(
  input: Readonly<{ projectDir: string; tool: CliToolId }>,
): Promise<RememberedCliRuntime | null> {
  const cache = await readCache(input.projectDir);
  if (cache === null || Date.now() - cache.fetchedAt >= DEFAULT_TTL_MS) return null;
  const remembered = cache.cliTools.find((cli) => cli.tool === input.tool);
  if (remembered === undefined) return null;
  const { installedVersion, fingerprint } = remembered;
  if (installedVersion === null || fingerprint === null) return null;
  return { installedVersion, fingerprint };
}

/**
 * Writes only into an existing `.splitbrief/`. The first config save creates the folder together
 * with its ignore rule, so discovery before that save leaves the checkout untouched.
 */
export async function saveDetectionCache(input: SaveDetectionCacheInput): Promise<void> {
  if (!existsSync(getSplitbriefPath(input.projectDir))) return;
  const cache = buildCache(input.snapshot);
  if (cache === null) return;

  try {
    const path = cachePath(input.projectDir);
    await writeConfinedSecureFileAsync(
      input.projectDir,
      relative(input.projectDir, path),
      JSON.stringify(cache),
    );
  } catch {
    // Cache write failure is non-critical.
  }
}

export async function invalidateCache(projectDir: string): Promise<void> {
  try {
    confinedUnlinkSync(projectDir, CACHE_RELATIVE_PATH);
  } catch {
    // File doesn't exist or can't be deleted — non-critical.
  }
}
