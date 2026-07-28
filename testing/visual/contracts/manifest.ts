import { z } from 'zod';
import { ArtifactRecordSchema } from './artifacts.js';
import { getFailureArtifactIdentity } from './failure-identity.js';
import { FailureSchema } from './failures.js';
import type { ArtifactKey } from './identifiers.js';
import {
  MAX_ARTIFACTS_PER_MANIFEST,
  MAX_DIAGNOSTICS_PER_MANIFEST,
  MAX_MANIFEST_DERIVED_PIXEL_AREA,
} from './limits.js';
import {
  ControlPolicyMetadataSchema,
  DeterminismEnvelopeSchema,
  HyperlinkPolicyMetadataSchema,
  RendererMetadataSchema,
  WarningSchema,
} from './manifest-fields.js';
import {
  collectDiagnosticArtifactKeys,
  validateManifestAccounting,
} from './manifest-accounting.js';
import { GitRevisionSchema, ToolVersionSchema } from './persisted-data.js';
import { addDuplicateIssues } from './refinement.js';
import {
  CATALOG_SCHEMA_VERSION,
  CELL_GRID_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
} from './schema-versions.js';
import {
  captureAccountingKey,
  CaptureSelectionSchema,
  type ArtifactProvenance,
} from './selection.js';

export const ManifestSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    catalogVersion: z.literal(CATALOG_SCHEMA_VERSION),
    cellSchemaVersion: z.literal(CELL_GRID_SCHEMA_VERSION),
    tool: z
      .object({
        name: z.literal('splitbrief-tui-shots'),
        version: ToolVersionSchema,
      })
      .strict()
      .readonly(),
    gitRevision: GitRevisionSchema.nullable(),
    selection: CaptureSelectionSchema,
    determinism: DeterminismEnvelopeSchema,
    controlPolicy: ControlPolicyMetadataSchema,
    hyperlinkPolicy: HyperlinkPolicyMetadataSchema,
    renderer: RendererMetadataSchema.nullable(),
    artifacts: z.array(ArtifactRecordSchema).max(MAX_ARTIFACTS_PER_MANIFEST).readonly(),
    warnings: z.array(WarningSchema).max(MAX_DIAGNOSTICS_PER_MANIFEST).readonly(),
    failures: z.array(FailureSchema).max(MAX_DIAGNOSTICS_PER_MANIFEST).readonly(),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateIssues({
      values: manifest.artifacts.map((artifact) => artifact.identity.key),
      label: 'artifacts',
      context,
    });

    if (manifest.artifacts.length === 0 && manifest.failures.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'a non-empty selection must produce an artifact or a failure',
        path: ['artifacts'],
      });
    }

    if (manifest.warnings.length + manifest.failures.length > MAX_DIAGNOSTICS_PER_MANIFEST) {
      context.addIssue({
        code: 'custom',
        message: `warnings and failures exceed the aggregate limit of ${MAX_DIAGNOSTICS_PER_MANIFEST}`,
        path: ['warnings'],
      });
    }

    validateManifestAccounting({ manifest, context });
    validateRasterContract({ manifest, context });

    addDuplicateIssues({
      values: manifest.artifacts.flatMap((artifact) => [
        artifact.files.ansi,
        artifact.files.txt,
        artifact.files.cells,
        ...(artifact.files.svg ? [artifact.files.svg] : []),
        ...(artifact.files.png ? [artifact.files.png] : []),
      ]),
      label: 'artifact paths',
      context,
    });

    const diagnosticArtifactKeys = collectDiagnosticArtifactKeys(manifest);
    for (const [index, warning] of manifest.warnings.entries()) {
      if (warning.artifactKey !== null && !diagnosticArtifactKeys.has(warning.artifactKey)) {
        context.addIssue({
          code: 'custom',
          message:
            'warning artifactKey does not resolve to an artifact or failed artifact identity',
          path: ['warnings', index, 'artifactKey'],
        });
      }
    }

    validateCropParentFrames({ manifest, context });
  })
  .readonly();
export type Manifest = z.infer<typeof ManifestSchema>;

export function parseManifest(value: unknown): Manifest {
  return ManifestSchema.parse(value);
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(ManifestSchema.parse(manifest), null, 2)}\n`;
}

function validateRasterContract(options: {
  readonly manifest: Manifest;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { manifest, context } = options;
  const hasDerivedArtifact = manifest.artifacts.some(
    (artifact) => artifact.files.svg !== null || artifact.files.png !== null,
  );
  if (manifest.renderer === null && hasDerivedArtifact) {
    context.addIssue({
      code: 'custom',
      message: 'renderer and font metrics are required when an SVG or PNG artifact is present',
      path: ['renderer'],
    });
  }
  if (manifest.renderer !== null) {
    validateManifestDerivedPixelArea(options);
  }
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (artifact.files.png !== null && artifact.files.svg === null) {
      context.addIssue({
        code: 'custom',
        message: 'PNG success requires SVG success for the same artifact',
        path: ['artifacts', index, 'files', 'png'],
      });
    }
  }
}

function validateManifestDerivedPixelArea(options: {
  readonly manifest: Manifest;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { manifest, context } = options;
  const renderer = manifest.renderer;
  if (renderer === null) return;

  let totalPixelArea = 0;
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const derivedOutputCount =
      Number(artifact.files.svg !== null) + Number(artifact.files.png !== null);
    if (derivedOutputCount === 0) continue;

    totalPixelArea +=
      artifact.dimensions.cols *
      renderer.cellWidthPx *
      artifact.dimensions.rows *
      renderer.cellHeightPx *
      derivedOutputCount;
    if (totalPixelArea > MAX_MANIFEST_DERIVED_PIXEL_AREA) {
      context.addIssue({
        code: 'custom',
        message: `derived output exceeds ${MAX_MANIFEST_DERIVED_PIXEL_AREA} aggregate pixels`,
        path: ['artifacts', index, 'files'],
      });
      return;
    }
  }
}

function validateCropParentFrames(options: {
  readonly manifest: Manifest;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { manifest, context } = options;
  const frameIdentities = new Set<string>();

  for (const artifact of manifest.artifacts) {
    if (artifact.identity.kind === 'frame') {
      frameIdentities.add(
        frameIdentitySignature({
          key: artifact.identity.key,
          provenance: artifact.identity.provenance,
        }),
      );
    }
  }
  for (const failure of manifest.failures) {
    const identity = getFailureArtifactIdentity(failure);
    if (identity?.kind === 'frame') {
      frameIdentities.add(
        frameIdentitySignature({ key: identity.key, provenance: identity.provenance }),
      );
    }
  }

  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (artifact.identity.kind !== 'crop') continue;
    addMissingParentFrameIssue({
      frameIdentities,
      parentFrameKey: artifact.identity.parentFrameKey,
      provenance: artifact.identity.provenance,
      path: ['artifacts', index, 'identity', 'parentFrameKey'],
      context,
    });
  }

  for (const [index, failure] of manifest.failures.entries()) {
    if (failure.stage === 'locator') {
      addMissingParentFrameIssue({
        frameIdentities,
        parentFrameKey: failure.parentFrameKey,
        provenance: failure.provenance,
        path: ['failures', index, 'parentFrameKey'],
        context,
      });
      continue;
    }

    const identity = getFailureArtifactIdentity(failure);
    if (identity?.kind === 'crop') {
      addMissingParentFrameIssue({
        frameIdentities,
        parentFrameKey: identity.parentFrameKey,
        provenance: identity.provenance,
        path: ['failures', index, 'artifact', 'parentFrameKey'],
        context,
      });
    }
  }
}

function addMissingParentFrameIssue(options: {
  readonly frameIdentities: ReadonlySet<string>;
  readonly parentFrameKey: ArtifactKey;
  readonly provenance: ArtifactProvenance;
  readonly path: PropertyKey[];
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  if (
    options.frameIdentities.has(
      frameIdentitySignature({
        key: options.parentFrameKey,
        provenance: options.provenance,
      }),
    )
  ) {
    return;
  }

  options.context.addIssue({
    code: 'custom',
    message: 'crop parent frame is missing or has different provenance',
    path: options.path,
  });
}

function frameIdentitySignature(options: {
  readonly key: ArtifactKey;
  readonly provenance: ArtifactProvenance;
}): string {
  const { key, provenance } = options;
  return JSON.stringify([
    key,
    captureAccountingKey(provenance),
    provenance.scenarioTitle,
    provenance.fixtureVersion,
  ]);
}
