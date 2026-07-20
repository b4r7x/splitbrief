import { z } from 'zod';
import { ArtifactKeySchema, SafeIdSchema } from './identifiers.js';
import { MAX_RENDERER_CELL_METRIC_PX, MIN_RENDERER_CELL_METRIC_PX } from './limits.js';
import { NonBlankPersistedTextSchema, ToolVersionSchema } from './persisted-data.js';
import { CONTROL_POLICY_VERSION, HYPERLINK_POLICY_VERSION } from './schema-versions.js';

export const WarningSchema = z
  .object({
    code: SafeIdSchema,
    message: NonBlankPersistedTextSchema.max(1_024),
    artifactKey: ArtifactKeySchema.nullable(),
  })
  .strict()
  .readonly();
export type Warning = z.infer<typeof WarningSchema>;

export const RendererMetadataSchema = z
  .object({
    name: NonBlankPersistedTextSchema.max(80),
    version: ToolVersionSchema,
    fontFamily: NonBlankPersistedTextSchema.max(256),
    cellWidthPx: z.number().int().min(MIN_RENDERER_CELL_METRIC_PX).max(MAX_RENDERER_CELL_METRIC_PX),
    cellHeightPx: z
      .number()
      .int()
      .min(MIN_RENDERER_CELL_METRIC_PX)
      .max(MAX_RENDERER_CELL_METRIC_PX),
  })
  .strict()
  .readonly();
export type RendererMetadata = z.infer<typeof RendererMetadataSchema>;

export const DeterminismEnvelopeSchema = z
  .object({
    timezone: NonBlankPersistedTextSchema.max(80),
    locale: NonBlankPersistedTextSchema.max(80),
    term: NonBlankPersistedTextSchema.max(80),
    colorLevel: z.number().int().min(0).max(3),
    hyperlinks: z.boolean(),
    motion: z.boolean(),
    clock: NonBlankPersistedTextSchema.max(80),
    randomSeed: NonBlankPersistedTextSchema.max(80),
  })
  .strict()
  .readonly();
export type DeterminismEnvelope = z.infer<typeof DeterminismEnvelopeSchema>;

export const ControlPolicyMetadataSchema = z
  .object({
    version: z.literal(CONTROL_POLICY_VERSION),
    ansi: z.literal('retained-diagnostic'),
    txt: z.literal('removed'),
    cells: z.literal('interpreted'),
    raster: z.literal('removed'),
  })
  .strict()
  .readonly();
export type ControlPolicyMetadata = z.infer<typeof ControlPolicyMetadataSchema>;

export const HyperlinkPolicyMetadataSchema = z
  .object({
    version: z.literal(HYPERLINK_POLICY_VERSION),
    ansi: z.literal('sanitized'),
    txt: z.literal('removed'),
    cells: z.literal('sanitized-structured'),
    raster: z.literal('non-interactive'),
    productionFiles: z.literal('project-relative-only'),
    externalUrls: z.literal('public-http-https-only'),
  })
  .strict()
  .readonly();
export type HyperlinkPolicyMetadata = z.infer<typeof HyperlinkPolicyMetadataSchema>;
