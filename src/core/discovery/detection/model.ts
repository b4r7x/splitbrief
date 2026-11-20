import { z } from 'zod';

/** One loaded instance, keyed by the exact identifier the server reports for it. */
export const DetectedModelInstanceSchema = z
  .object({
    id: z.string().min(1),
    effectiveContextTokens: z.number().int().positive().optional(),
  })
  .strict();
/** @public */
export type DetectedModelInstance = z.infer<typeof DetectedModelInstanceSchema>;

/** What the server said about loading at `observedAt`. An absent record means unknown. */
export const DetectedModelRuntimeSchema = z
  .object({
    loadState: z.enum(['loaded', 'not-loaded', 'unknown']),
    observedAt: z.number().finite().nonnegative(),
    instances: z.array(DetectedModelInstanceSchema).readonly().optional(),
  })
  .strict();
/** @public */
export type DetectedModelRuntime = z.infer<typeof DetectedModelRuntimeSchema>;

/**
 * `effectiveContextTokens` is the observed active context, `maximumContextTokens`
 * the architectural ceiling and `maximumOutputTokens` the output ceiling; a
 * ceiling never stands in for the active context.
 */
export const DetectedModelSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    detail: z.string().min(1).optional(),
    lifecycle: z.string().min(1).optional(),
    releaseDate: z.string().optional(),
    updatedDate: z.string().optional(),
    maximumContextTokens: z.number().int().positive().optional(),
    effectiveContextTokens: z.number().int().positive().optional(),
    maximumInputTokens: z.number().int().positive().optional(),
    maximumOutputTokens: z.number().int().positive().optional(),
    inputModalities: z.array(z.string().min(1)).readonly().optional(),
    outputModalities: z.array(z.string().min(1)).readonly().optional(),
    supportsToolCalls: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
    contextLength: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    supportsTemperature: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    supportsImages: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
    nativeOrder: z.number().int().nonnegative().optional(),
    nativeDefault: z.boolean().optional(),
    nativeHidden: z.boolean().optional(),
    nativeReasoningEfforts: z.array(z.string().trim().min(1)).readonly().optional(),
    nativeDefaultReasoningEffort: z.string().trim().min(1).optional(),
    runtime: DetectedModelRuntimeSchema.optional(),
  })
  .strict();
export type DetectedModel = z.infer<typeof DetectedModelSchema>;
