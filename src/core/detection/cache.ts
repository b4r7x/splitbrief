import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { PlannerDetection, ProviderDetection } from '../../types.js';
import { narrowRecord } from '../../utils/type-guards.js';

const CACHE_FILENAME = 'detection-cache.json';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const CACHE_VERSION = 1;

interface DetectionCache {
  version: number;
  timestamp: number;
  planners: PlannerDetection[];
  implementers: ProviderDetection[];
}

function cachePath(projectDir: string): string {
  return join(projectDir, '.tiny-spec', CACHE_FILENAME);
}

function isValidCache(value: unknown): value is DetectionCache {
  const rec = narrowRecord(value);
  if (!rec) return false;
  return (
    rec['version'] === CACHE_VERSION &&
    typeof rec['timestamp'] === 'number' &&
    Array.isArray(rec['planners']) &&
    Array.isArray(rec['implementers'])
  );
}

export async function loadDetectionCache(
  projectDir: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<{ planners: PlannerDetection[]; implementers: ProviderDetection[] } | null> {
  try {
    const raw = await readFile(cachePath(projectDir), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidCache(parsed)) return null;
    if (Date.now() - parsed.timestamp >= ttlMs) return null;
    return { planners: parsed.planners, implementers: parsed.implementers };
  } catch {
    return null;
  }
}

export async function saveDetectionCache(
  projectDir: string,
  planners: PlannerDetection[],
  implementers: ProviderDetection[],
): Promise<void> {
  const path = cachePath(projectDir);
  const cache: DetectionCache = { version: CACHE_VERSION, timestamp: Date.now(), planners, implementers };
  try {
    const tmpPath = path + '.tmp';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(cache), 'utf-8');
    await rename(tmpPath, path);
  } catch {
    // Cache write failure is non-critical
  }
}

export async function invalidateCache(projectDir: string): Promise<void> {
  try {
    await unlink(cachePath(projectDir));
  } catch {
    // File doesn't exist or can't be deleted — non-critical
  }
}
