import { z } from 'zod';
import { formatViewport, ViewportSchema } from './geometry.js';
import {
  CheckpointIdSchema,
  ElementIdSchema,
  ScenarioIdSchema,
  type ElementId,
} from './identifiers.js';
import {
  MAX_ARTIFACTS_PER_MANIFEST,
  MAX_CAPTURE_REQUESTS_PER_SELECTION,
  MAX_ELEMENTS_PER_SCENARIO,
} from './limits.js';
import { PersistedDiagnosticTextSchema } from './persisted-data.js';
import { addDuplicateIssues } from './refinement.js';

export const ArtifactProvenanceSchema = z
  .object({
    scenarioId: ScenarioIdSchema,
    scenarioTitle: PersistedDiagnosticTextSchema.min(1).max(160),
    fixtureVersion: z.number().int().positive(),
    checkpointId: CheckpointIdSchema,
    viewport: ViewportSchema,
  })
  .strict()
  .readonly();
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;

const CaptureEntryShape = {
  provenance: ArtifactProvenanceSchema,
  elementIds: z.array(ElementIdSchema).max(MAX_ELEMENTS_PER_SCENARIO).readonly(),
};

const CaptureEntrySchema = z
  .object(CaptureEntryShape)
  .strict()
  .superRefine((entry, context) => {
    addDuplicateIssues({
      values: entry.elementIds,
      label: 'capture elementIds',
      context,
    });
  })
  .readonly();

export const CaptureRequestSchema = CaptureEntrySchema;
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

export const CaptureTargetSchema = CaptureEntrySchema;
export type CaptureTarget = z.infer<typeof CaptureTargetSchema>;

const CaptureSelectionShapeSchema = z
  .object({
    requests: z
      .array(CaptureRequestSchema)
      .min(1)
      .max(MAX_CAPTURE_REQUESTS_PER_SELECTION)
      .readonly(),
    targets: z.array(CaptureTargetSchema).max(MAX_CAPTURE_REQUESTS_PER_SELECTION).readonly(),
  })
  .strict()
  .superRefine((selection, context) => {
    addDuplicateIssues({
      values: selection.requests.map((request) => captureAccountingKey(request.provenance)),
      label: 'capture requests',
      context,
    });
    addDuplicateIssues({
      values: selection.targets.map((target) => captureAccountingKey(target.provenance)),
      label: 'capture targets',
      context,
    });

    const requests = new Map(
      selection.requests.map((request) => [captureAccountingKey(request.provenance), request]),
    );

    for (const [index, target] of selection.targets.entries()) {
      const request = requests.get(captureAccountingKey(target.provenance));
      if (
        !request ||
        !hasMatchingProvenance({ left: request.provenance, right: target.provenance })
      ) {
        context.addIssue({
          code: 'custom',
          message: 'capture target does not match an explicit request',
          path: ['targets', index, 'provenance'],
        });
        continue;
      }
      if (!hasSameElements({ left: request.elementIds, right: target.elementIds })) {
        context.addIssue({
          code: 'custom',
          message: 'capture target elements do not match its explicit request',
          path: ['targets', index, 'elementIds'],
        });
      }
    }
  })
  .readonly();

export const CaptureSelectionSchema = z
  .custom(isBoundedCaptureSelectionInput, {
    message: `capture selection exceeds ${MAX_CAPTURE_REQUESTS_PER_SELECTION} requests or ${MAX_ARTIFACTS_PER_MANIFEST} expanded artifacts`,
  })
  .pipe(CaptureSelectionShapeSchema)
  .readonly();
export type CaptureSelection = z.infer<typeof CaptureSelectionSchema>;

export interface ProvenancePair {
  readonly left: ArtifactProvenance;
  readonly right: ArtifactProvenance;
}

export function hasMatchingProvenance(options: ProvenancePair): boolean {
  const { left, right } = options;
  return (
    left.scenarioId === right.scenarioId &&
    left.scenarioTitle === right.scenarioTitle &&
    left.fixtureVersion === right.fixtureVersion &&
    left.checkpointId === right.checkpointId &&
    left.viewport.cols === right.viewport.cols &&
    left.viewport.rows === right.viewport.rows
  );
}

export function captureAccountingKey(provenance: ArtifactProvenance): string {
  return `${provenance.scenarioId}:${provenance.checkpointId}:${formatViewport(provenance.viewport)}`;
}

function isBoundedCaptureSelectionInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return (
    (!('requests' in value) || hasBoundedCaptureEntries(value.requests)) &&
    (!('targets' in value) || hasBoundedCaptureEntries(value.targets))
  );
}

function hasBoundedCaptureEntries(value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  if (value.length > MAX_CAPTURE_REQUESTS_PER_SELECTION) return false;

  let expandedArtifactCount = 0;
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || !('elementIds' in entry)) continue;
    if (!Array.isArray(entry.elementIds)) continue;
    if (entry.elementIds.length > MAX_ELEMENTS_PER_SCENARIO) return false;
    expandedArtifactCount += 1 + entry.elementIds.length;
    if (expandedArtifactCount > MAX_ARTIFACTS_PER_MANIFEST) return false;
  }
  return true;
}

function hasSameElements(options: {
  readonly left: readonly ElementId[];
  readonly right: readonly ElementId[];
}): boolean {
  if (options.left.length !== options.right.length) return false;
  const leftElements = new Set(options.left);
  return options.right.every((element) => leftElements.has(element));
}
