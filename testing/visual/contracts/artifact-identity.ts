import { z } from 'zod';
import {
  ArtifactKeySchema,
  artifactKey,
  ElementIdSchema,
  type ArtifactKey,
  type ElementId,
} from './identifiers.js';
import {
  ArtifactProvenanceSchema,
  captureAccountingKey,
  type ArtifactProvenance,
} from './selection.js';

const ARTIFACT_KIND = {
  frame: 'frame',
  crop: 'crop',
} as const;

export const FrameArtifactIdentitySchema = z
  .object({
    kind: z.literal(ARTIFACT_KIND.frame),
    key: ArtifactKeySchema,
    provenance: ArtifactProvenanceSchema,
    elementId: z.null(),
    parentFrameKey: z.null(),
  })
  .strict()
  .superRefine((identity, context) => {
    const expectedKey = frameAccountingKey(identity.provenance);
    if (identity.key !== expectedKey) {
      context.addIssue({
        code: 'custom',
        message: `frame key must match its provenance: ${expectedKey}`,
        path: ['key'],
      });
    }
  })
  .readonly();
export type FrameArtifactIdentity = z.infer<typeof FrameArtifactIdentitySchema>;

export const CropArtifactIdentitySchema = z
  .object({
    kind: z.literal(ARTIFACT_KIND.crop),
    key: ArtifactKeySchema,
    provenance: ArtifactProvenanceSchema,
    elementId: ElementIdSchema,
    parentFrameKey: ArtifactKeySchema,
  })
  .strict()
  .superRefine((identity, context) => {
    const expectedKey = cropAccountingKey({
      provenance: identity.provenance,
      elementId: identity.elementId,
    });
    if (identity.key !== expectedKey) {
      context.addIssue({
        code: 'custom',
        message: `crop key must match its provenance and element: ${expectedKey}`,
        path: ['key'],
      });
    }

    const expectedParentKey = frameAccountingKey(identity.provenance);
    if (identity.parentFrameKey !== expectedParentKey) {
      context.addIssue({
        code: 'custom',
        message: `crop parent key must match its provenance: ${expectedParentKey}`,
        path: ['parentFrameKey'],
      });
    }
  })
  .readonly();
export type CropArtifactIdentity = z.infer<typeof CropArtifactIdentitySchema>;

export const ArtifactIdentitySchema = z
  .discriminatedUnion('kind', [FrameArtifactIdentitySchema, CropArtifactIdentitySchema])
  .readonly();
export type ArtifactIdentity = z.infer<typeof ArtifactIdentitySchema>;

export function frameArtifactKey(provenance: ArtifactProvenance): ArtifactKey {
  return artifactKey(frameAccountingKey(provenance));
}

export function cropArtifactKey(options: {
  readonly provenance: ArtifactProvenance;
  readonly elementId: ElementId;
}): ArtifactKey {
  return artifactKey(cropAccountingKey(options));
}

export function frameAccountingKey(provenance: ArtifactProvenance): string {
  return `${captureAccountingKey(provenance)}:frame`;
}

export function cropAccountingKey(options: {
  readonly provenance: ArtifactProvenance;
  readonly elementId: ElementId;
}): string {
  return `${captureAccountingKey(options.provenance)}:crop:${options.elementId}`;
}
