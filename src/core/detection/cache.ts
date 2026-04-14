import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { PlannerDetection, ProviderDetection } from '../types/index.js';
import { PLANNER_TOOL_IDS, PROVIDER_IDS } from '../types/schemas/enums.js';
import { getDiptychPath } from '../../utils/fs.js';

const CACHE_FILENAME = 'detection-cache.json';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const CACHE_VERSION = 1;

const DetectedModelSchema = z.object({
  id: z.string(),
  contextLength: z.number().optional(),
  pricingInput: z.number().optional(),
  pricingOutput: z.number().optional(),
  isFree: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
  releaseDate: z.string().optional(),
});

const PlannerDetectionSchema = z.object({
  tool: z.enum(PLANNER_TOOL_IDS),
  type: z.enum(['cli', 'api', 'shell']),
  available: z.boolean(),
  version: z.string().optional(),
  description: z.string().optional(),
  error: z.string().optional(),
});

const ProviderDetectionSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  available: z.boolean(),
  models: z.array(DetectedModelSchema).optional(),
  isLocal: z.boolean(),
  hasKey: z.boolean().optional(),
});

const DetectionCacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  timestamp: z.number(),
  planners: z.array(PlannerDetectionSchema),
  implementers: z.array(ProviderDetectionSchema),
});

type DetectionCache = z.infer<typeof DetectionCacheSchema>;

function cachePath(projectDir: string): string {
  return getDiptychPath(projectDir, CACHE_FILENAME);
}

function parseCache(value: unknown): DetectionCache | null {
  const result = DetectionCacheSchema.safeParse(value);
  if (!result.success) return null;
  return result.data;
}

export async function loadDetectionCache(
  projectDir: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<{ planners: PlannerDetection[]; implementers: ProviderDetection[] } | null> {
  try {
    const raw = await readFile(cachePath(projectDir), 'utf-8');
    const parsed = parseCache(JSON.parse(raw));
    if (!parsed) return null;
    if (Date.now() - parsed.timestamp >= ttlMs) return null;
    return { planners: parsed.planners as PlannerDetection[], implementers: parsed.implementers as ProviderDetection[] };
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
