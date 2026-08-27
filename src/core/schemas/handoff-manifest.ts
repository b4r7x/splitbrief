import { z } from 'zod';
import { WorkflowModeSchema } from './enums.js';

/**
 * Machine-readable index for external tools to verify pack integrity,
 * detect staleness, and discover artifacts without parsing markdown.
 *
 * Built-in target values: 'spec-kit' | 'agents-md' | 'claude-code' | 'copilot-issue'
 * The field is intentionally OPEN (z.string()) to allow
 * custom renderer basenames without requiring a schema bump.
 */
export const HandoffManifestSchema = z.object({
  packVersion: z.literal('1'),
  splitbriefVersion: z.string(),
  generatedAt: z.string(),
  sessionId: z.string(),
  briefHash: z.string(),
  sourceCommit: z.string().optional(),
  target: z.string(),
  mode: WorkflowModeSchema,
  taskIds: z.array(z.string()),
  artifacts: z.object({
    spec: z.literal('spec.md').optional(),
    plan: z.literal('plan.md').optional(),
    constitution: z.literal('constitution.md').optional(),
    tasks: z.array(z.string()),
  }),
  validation: z.object({
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    test: z.string().optional(),
  }),
  notes: z.string().optional(),
});

export type HandoffManifest = z.infer<typeof HandoffManifestSchema>;
