import { z } from 'zod';
import { ACTIVE_OVERLAYS, ALL_SCREENS } from '../../../src/core/navigation/types.js';
import { formatViewport, ViewportSchema } from './geometry.js';
import { CheckpointIdSchema, ElementIdSchema, ScenarioIdSchema } from './identifiers.js';
import {
  MAX_CHECKPOINTS_PER_SCENARIO,
  MAX_ELEMENTS_PER_SCENARIO,
  MAX_VIEWPORTS_PER_SCENARIO,
} from './limits.js';
import { NonBlankPersistedTextSchema } from './persisted-data.js';
import { addDuplicateIssues } from './refinement.js';

const SURFACE_KIND = {
  screen: 'screen',
  overlay: 'overlay',
} as const;

export const SurfaceKindSchema = z.enum([SURFACE_KIND.screen, SURFACE_KIND.overlay]);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const ScreenSurfaceSchema = z.enum(ALL_SCREENS);
export type ScreenSurface = z.infer<typeof ScreenSurfaceSchema>;

export const OverlaySurfaceSchema = z.enum(ACTIVE_OVERLAYS);
export type OverlaySurface = z.infer<typeof OverlaySurfaceSchema>;

export const SurfaceSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal(SURFACE_KIND.screen),
        screen: ScreenSurfaceSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal(SURFACE_KIND.overlay),
        overlay: OverlaySurfaceSchema,
        underlyingScreen: ScreenSurfaceSchema,
      })
      .strict(),
  ])
  .readonly();
export type Surface = z.infer<typeof SurfaceSchema>;

export const CheckpointKindSchema = z.enum([
  'ready',
  'idle',
  'planning',
  'implementation',
  'review',
  'question',
  'success',
  'failure',
]);
export type CheckpointKind = z.infer<typeof CheckpointKindSchema>;

export const CheckpointDefinitionSchema = z
  .object({
    id: CheckpointIdSchema,
    title: NonBlankPersistedTextSchema.max(160),
    kind: CheckpointKindSchema,
    marker: NonBlankPersistedTextSchema.max(256),
    timeoutMs: z.number().int().positive().max(30_000),
  })
  .strict()
  .readonly();
export type CheckpointDefinition = z.infer<typeof CheckpointDefinitionSchema>;

export const ElementDefinitionSchema = z
  .object({
    id: ElementIdSchema,
    title: NonBlankPersistedTextSchema.max(160),
    required: z.boolean(),
  })
  .strict()
  .readonly();
export type ElementDefinition = z.infer<typeof ElementDefinitionSchema>;

export const ScenarioDefinitionSchema = z
  .object({
    id: ScenarioIdSchema,
    title: NonBlankPersistedTextSchema.max(160),
    surface: SurfaceSchema,
    fixtureVersion: z.number().int().positive(),
    viewports: z.array(ViewportSchema).min(1).max(MAX_VIEWPORTS_PER_SCENARIO).readonly(),
    checkpoints: z
      .array(CheckpointDefinitionSchema)
      .min(1)
      .max(MAX_CHECKPOINTS_PER_SCENARIO)
      .readonly(),
    elements: z.array(ElementDefinitionSchema).max(MAX_ELEMENTS_PER_SCENARIO).readonly(),
  })
  .strict()
  .superRefine((scenario, context) => {
    addDuplicateIssues({
      values: scenario.viewports.map(formatViewport),
      label: 'viewports',
      context,
    });
    addDuplicateIssues({
      values: scenario.checkpoints.map((checkpoint) => checkpoint.id),
      label: 'checkpoints',
      context,
    });
    addDuplicateIssues({
      values: scenario.elements.map((element) => element.id),
      label: 'elements',
      context,
    });
  })
  .readonly();
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;
