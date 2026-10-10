import { z } from 'zod';
import { ModelsDevCatalogSchema, type ModelsDevCatalog } from '../../../core/schemas/models-dev.js';

export const MODELS_DEV_CACHE_VERSION = 1;
export const MODELS_DEV_ETAG_MAX_LENGTH = 4_096;
export const MODELS_DEV_SOURCE_URL_MAX_LENGTH = 2_048;

const ModelsDevCacheRecordSchema = z
  .object({
    version: z.literal(MODELS_DEV_CACHE_VERSION),
    sourceUrl: z.string().min(1).max(MODELS_DEV_SOURCE_URL_MAX_LENGTH),
    parserVersion: z.string().min(1).max(256),
    catalog: ModelsDevCatalogSchema,
    etag: z.string().min(1).max(MODELS_DEV_ETAG_MAX_LENGTH).optional(),
    fetchedAt: z.number().finite().nonnegative(),
    validatedAt: z.number().finite().nonnegative(),
  })
  .strict();
export type ModelsDevCacheRecord = z.infer<typeof ModelsDevCacheRecordSchema>;
export type ModelsDevCacheMetadata = Pick<
  ModelsDevCacheRecord,
  'sourceUrl' | 'parserVersion' | 'validatedAt'
>;
export type ParsedModelsDevCatalog =
  | Readonly<{ kind: 'valid'; catalog: ModelsDevCatalog }>
  | Readonly<{ kind: 'invalid-json' }>
  | Readonly<{ kind: 'invalid-schema' }>;
export interface ModelsDevParseRequest {
  readonly kind: 'record' | 'metadata' | 'catalog';
  readonly raw: string;
}
export type ModelsDevParseResult =
  | ModelsDevCacheRecord
  | ModelsDevCacheMetadata
  | ParsedModelsDevCatalog
  | null;

export function parsePayload(request: ModelsDevParseRequest): ModelsDevParseResult {
  let json: unknown;
  try {
    json = JSON.parse(request.raw);
  } catch {
    return request.kind === 'catalog' ? { kind: 'invalid-json' } : null;
  }

  if (request.kind === 'catalog') {
    const parsed = ModelsDevCatalogSchema.safeParse(json);
    return parsed.success ? { kind: 'valid', catalog: parsed.data } : { kind: 'invalid-schema' };
  }

  const parsed = ModelsDevCacheRecordSchema.safeParse(json);
  if (!parsed.success) return null;
  if (request.kind === 'record') return parsed.data;
  return {
    sourceUrl: parsed.data.sourceUrl,
    parserVersion: parsed.data.parserVersion,
    validatedAt: parsed.data.validatedAt,
  };
}
