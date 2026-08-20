import { z } from 'zod';
import { RUNTIME_CONFORMANCE_FILE, getSplitbriefPath } from '../../core/paths.js';
import { CacheVersionStringBaseSchema } from '../../core/schemas/cache-version.js';
import { readValidatedJsonResult, writeSecureFile } from '../../lib/fs.js';
import { warnError } from '../../lib/warn.js';

const RUNTIME_CONFORMANCE_CACHE_VERSION = 1;

const MAX_CONFORMANCE_ENTRIES = 100;

const RuntimeConformanceEntrySchema = z
  .object({
    backend: z.string().min(1),
    version: CacheVersionStringBaseSchema,
    recordedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

type RuntimeConformanceEntry = z.infer<typeof RuntimeConformanceEntrySchema>;

const RuntimeConformanceCacheSchema = z
  .object({
    version: z.literal(RUNTIME_CONFORMANCE_CACHE_VERSION),
    entries: z.array(RuntimeConformanceEntrySchema).max(MAX_CONFORMANCE_ENTRIES),
  })
  .strict();

type RuntimeConformanceCache = z.infer<typeof RuntimeConformanceCacheSchema>;

function parseRuntimeConformance(value: unknown): RuntimeConformanceCache | null {
  const result = RuntimeConformanceCacheSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function readRuntimeConformance(projectDir: string): RuntimeConformanceCache | null {
  try {
    const result = readValidatedJsonResult(
      getSplitbriefPath(projectDir, RUNTIME_CONFORMANCE_FILE),
      parseRuntimeConformance,
    );
    return result.kind === 'value' ? result.value : null;
  } catch {
    return null;
  }
}

export function hasRuntimeConformance(
  cache: RuntimeConformanceCache | null,
  entry: Readonly<Pick<RuntimeConformanceEntry, 'backend' | 'version'>>,
): boolean {
  if (cache === null) return false;
  return cache.entries.some((e) => e.backend === entry.backend && e.version === entry.version);
}

export function recordRuntimeConformance(
  projectDir: string,
  entry: Readonly<Pick<RuntimeConformanceEntry, 'backend' | 'version'>>,
): void {
  try {
    const existing = readRuntimeConformance(projectDir);
    const filtered = (existing?.entries ?? []).filter(
      (e) => !(e.backend === entry.backend && e.version === entry.version),
    );
    const candidate = {
      version: RUNTIME_CONFORMANCE_CACHE_VERSION,
      entries: [
        ...filtered.slice(Math.max(0, filtered.length - (MAX_CONFORMANCE_ENTRIES - 1))),
        {
          backend: entry.backend,
          version: entry.version,
          recordedAt: Date.now(),
        },
      ],
    };
    const updated = RuntimeConformanceCacheSchema.safeParse(candidate);
    if (!updated.success) {
      warnError('runtime-conformance: refusing to record out-of-bounds evidence', updated.error);
      return;
    }
    writeSecureFile(
      getSplitbriefPath(projectDir, RUNTIME_CONFORMANCE_FILE),
      JSON.stringify(updated.data, null, 2) + '\n',
    );
  } catch (err) {
    warnError('runtime-conformance: failed to save', err);
  }
}
