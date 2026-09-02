import { z } from 'zod';
import { ArtifactIdentitySchema } from './artifact-identity.js';
import { ArtifactKeySchema, ElementIdSchema, SafeIdSchema } from './identifiers.js';
import { PersistedDiagnosticTextSchema } from './persisted-data.js';
import { ArtifactProvenanceSchema } from './selection.js';

export const FailureStageSchema = z.enum([
  'selection',
  'fixture',
  'checkpoint',
  'terminal',
  'locator',
  'serialization',
  'svg',
  'png',
  'write',
  'cleanup',
  'pty',
]);
export type FailureStage = z.infer<typeof FailureStageSchema>;

const FAILURE_STAGE = FailureStageSchema.enum;

const FailureBaseShape = {
  code: SafeIdSchema,
  message: PersistedDiagnosticTextSchema.min(1).max(2_048),
};

export const SelectionFailureTargetSchema = z
  .object({
    kind: z.literal('capture'),
    provenance: ArtifactProvenanceSchema,
  })
  .strict()
  .readonly();
export type SelectionFailureTarget = z.infer<typeof SelectionFailureTargetSchema>;

export const CleanupFailureTargetSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('run') }).strict(),
    z
      .object({
        kind: z.literal('capture'),
        provenance: ArtifactProvenanceSchema,
      })
      .strict(),
    z.object({ kind: z.literal('artifact'), artifact: ArtifactIdentitySchema }).strict(),
  ])
  .readonly();

export const FailureSchema = z
  .discriminatedUnion('stage', [
    z
      .object({
        ...FailureBaseShape,
        stage: z.literal(FAILURE_STAGE.selection),
        target: SelectionFailureTargetSchema,
      })
      .strict(),
    z
      .object({
        ...FailureBaseShape,
        stage: z.literal(FAILURE_STAGE.fixture),
        provenance: ArtifactProvenanceSchema,
      })
      .strict(),
    createProvenanceFailureSchema(FAILURE_STAGE.checkpoint),
    createProvenanceFailureSchema(FAILURE_STAGE.terminal),
    createProvenanceFailureSchema(FAILURE_STAGE.pty),
    z
      .object({
        ...FailureBaseShape,
        stage: z.literal(FAILURE_STAGE.locator),
        provenance: ArtifactProvenanceSchema,
        elementId: ElementIdSchema,
        parentFrameKey: ArtifactKeySchema,
      })
      .strict(),
    createArtifactFailureSchema(FAILURE_STAGE.serialization),
    createArtifactFailureSchema(FAILURE_STAGE.svg),
    createArtifactFailureSchema(FAILURE_STAGE.png),
    createArtifactFailureSchema(FAILURE_STAGE.write),
    z
      .object({
        ...FailureBaseShape,
        stage: z.literal(FAILURE_STAGE.cleanup),
        target: CleanupFailureTargetSchema,
      })
      .strict(),
  ])
  .readonly();
export type Failure = z.infer<typeof FailureSchema>;

function createProvenanceFailureSchema<
  const Stage extends
    | typeof FAILURE_STAGE.checkpoint
    | typeof FAILURE_STAGE.terminal
    | typeof FAILURE_STAGE.pty,
>(stage: Stage) {
  return z
    .object({
      ...FailureBaseShape,
      stage: z.literal(stage),
      provenance: ArtifactProvenanceSchema,
    })
    .strict();
}

function createArtifactFailureSchema<
  const Stage extends
    | typeof FAILURE_STAGE.serialization
    | typeof FAILURE_STAGE.svg
    | typeof FAILURE_STAGE.png
    | typeof FAILURE_STAGE.write,
>(stage: Stage) {
  return z
    .object({
      ...FailureBaseShape,
      stage: z.literal(stage),
      artifact: ArtifactIdentitySchema,
    })
    .strict();
}
