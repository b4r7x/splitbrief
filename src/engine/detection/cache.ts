import { join, relative } from 'node:path';
import { z } from 'zod';
import { writeConfinedSecureFileAsync } from '../../lib/fs.js';
import { confinedReadFileAsync, confinedUnlinkSync } from '../../lib/confined-fs.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import {
  CliToolDetectionSchema,
  ProviderDetectionSchema,
  type CliToolDetection,
  type ProviderDetection,
} from '../../core/discovery/detection.js';
import { getSplitbriefPath } from '../../core/paths.js';

const CACHE_FILENAME = 'detection-cache.json';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const CACHE_VERSION = 2;

const DetectionCacheSchema = z
  .object({
    version: z.literal(CACHE_VERSION),
    timestamp: z.number(),
    providers: z.array(ProviderDetectionSchema),
    cliTools: z.array(CliToolDetectionSchema),
  })
  .strict();

type DetectionCache = z.infer<typeof DetectionCacheSchema>;

function cachePath(projectDir: string): string {
  return getSplitbriefPath(projectDir, CACHE_FILENAME);
}

function parseCache(value: unknown): DetectionCache | null {
  const result = DetectionCacheSchema.safeParse(value);
  if (!result.success) return null;
  return result.data;
}

const CACHE_RELATIVE_PATH = join(SPLITBRIEF_DIR, CACHE_FILENAME);

async function readCacheRaw(projectDir: string): Promise<unknown | null> {
  try {
    const raw = await confinedReadFileAsync(projectDir, CACHE_RELATIVE_PATH);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadDetectionCache(
  projectDir: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<{ providers: ProviderDetection[]; cliTools: CliToolDetection[] } | null> {
  const parsed = parseCache(await readCacheRaw(projectDir));
  if (!parsed) return null;
  if (Date.now() - parsed.timestamp >= ttlMs) return null;
  return { providers: parsed.providers, cliTools: parsed.cliTools };
}

export async function saveDetectionCache(
  projectDir: string,
  providers: ProviderDetection[],
  cliTools: CliToolDetection[],
): Promise<void> {
  const path = cachePath(projectDir);
  const cache: DetectionCache = {
    version: CACHE_VERSION,
    timestamp: Date.now(),
    providers,
    cliTools,
  };
  try {
    await writeConfinedSecureFileAsync(
      projectDir,
      relative(projectDir, path),
      JSON.stringify(cache),
    );
  } catch {
    // Cache write failure is non-critical
  }
}

export async function invalidateCache(projectDir: string): Promise<void> {
  try {
    confinedUnlinkSync(projectDir, CACHE_RELATIVE_PATH);
  } catch {
    // File doesn't exist or can't be deleted — non-critical
  }
}
