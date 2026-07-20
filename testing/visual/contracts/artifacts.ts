import { z } from 'zod';
import { CropArtifactIdentitySchema, FrameArtifactIdentitySchema } from './artifact-identity.js';
import {
  CellRectSchema,
  isCellRectInViewport,
  isFullFrameRect,
  ViewportSchema,
} from './geometry.js';
import { RelativeArtifactPathSchema } from './identifiers.js';
import { NonBlankPersistedTextSchema } from './persisted-data.js';

const AnsiArtifactPathSchema = createArtifactPathSchema('.ansi');
const TextArtifactPathSchema = createArtifactPathSchema('.txt');
const CellsArtifactPathSchema = createArtifactPathSchema('.cells.json');
const SvgArtifactPathSchema = createArtifactPathSchema('.svg');
const PngArtifactPathSchema = createArtifactPathSchema('.png');

export const ArtifactFilesSchema = z
  .object({
    ansi: AnsiArtifactPathSchema,
    txt: TextArtifactPathSchema,
    cells: CellsArtifactPathSchema,
    svg: SvgArtifactPathSchema.nullable(),
    png: PngArtifactPathSchema.nullable(),
  })
  .strict()
  .readonly();
export type ArtifactFiles = z.infer<typeof ArtifactFilesSchema>;

const ArtifactRecordShape = {
  rect: CellRectSchema,
  dimensions: ViewportSchema,
  files: ArtifactFilesSchema,
};

export const ArtifactRecordSchema = z
  .union([
    z
      .object({
        ...ArtifactRecordShape,
        identity: FrameArtifactIdentitySchema,
        locator: z.null(),
      })
      .strict(),
    z
      .object({
        ...ArtifactRecordShape,
        identity: CropArtifactIdentitySchema,
        locator: z
          .object({
            kind: z.enum(['layout', 'marker']),
            description: NonBlankPersistedTextSchema.max(256),
          })
          .strict()
          .readonly(),
      })
      .strict(),
  ])
  .superRefine((artifact, context) => {
    if (
      artifact.dimensions.cols !== artifact.rect.width ||
      artifact.dimensions.rows !== artifact.rect.height
    ) {
      context.addIssue({
        code: 'custom',
        message: 'artifact dimensions do not match its rectangle',
        path: ['dimensions'],
      });
    }

    const viewport = artifact.identity.provenance.viewport;
    if (!isCellRectInViewport(artifact.rect, viewport)) {
      context.addIssue({
        code: 'custom',
        message: 'artifact rectangle exceeds its source viewport',
        path: ['rect'],
      });
    }
    if (artifact.identity.kind === 'frame' && !isFullFrameRect(artifact.rect, viewport)) {
      context.addIssue({
        code: 'custom',
        message: 'frame artifact rectangle must fill its viewport',
        path: ['rect'],
      });
    }
  })
  .readonly();
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

function createArtifactPathSchema(suffix: string) {
  return RelativeArtifactPathSchema.refine((path) => path.endsWith(suffix), {
    message: `artifact path must end with ${suffix}`,
  });
}
