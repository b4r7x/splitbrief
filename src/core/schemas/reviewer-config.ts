import { z } from 'zod';
import {
  GenerationCommonFields,
  commandKindCapabilityGuard,
  createPlannerConfigSchema,
} from './runner-fields.js';

export const ReviewerConfigSchema = createPlannerConfigSchema(
  {
    ...GenerationCommonFields,
    model: z.string().min(1).optional(),
  },
  'reviewer',
).superRefine(commandKindCapabilityGuard('reviewer'));

// Invariant gate 18 fails on an exported type nothing imports, so the per-kind `Extract<>`
// aliases the planner sibling carries land here with their first consumer, not before.
export type ReviewerConfig = z.infer<typeof ReviewerConfigSchema>;
