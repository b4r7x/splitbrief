import { z } from 'zod';

export const READINESS_SEVERITIES = ['ok', 'info', 'warning', 'blocker'] as const;
export const ReadinessSeveritySchema = z.enum(READINESS_SEVERITIES);
export type ReadinessSeverity = z.infer<typeof ReadinessSeveritySchema>;

export const READINESS_STATUSES = ['ready', 'ready-with-warnings', 'blocked'] as const;
export const ReadinessStatusSchema = z.enum(READINESS_STATUSES);
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;

export const READINESS_NEXT_ACTION_KINDS = [
  'continue',
  'run-init',
  'fix-config',
  'clean-or-isolate-repo',
  'raise-context',
  'set-budget',
  'exit',
] as const;
export const ReadinessNextActionKindSchema = z.enum(READINESS_NEXT_ACTION_KINDS);
export type ReadinessNextActionKind = z.infer<typeof ReadinessNextActionKindSchema>;

export type ReadinessMetadata =
  | string
  | number
  | boolean
  | null
  | ReadinessMetadata[]
  | { [key: string]: ReadinessMetadata };

export const ReadinessMetadataSchema: z.ZodType<ReadinessMetadata> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ReadinessMetadataSchema),
    z.record(z.string(), ReadinessMetadataSchema),
  ]),
);

export const StartReadinessCheckSchema = z.object({
  id: z.string(),
  severity: ReadinessSeveritySchema,
  summary: z.string(),
});

export const StartReadinessRecordSchema = z.object({
  type: z.literal('start-readiness'),
  generatedAt: z.string(),
  status: ReadinessStatusSchema,
  nextAction: ReadinessNextActionKindSchema,
  blockerCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  checks: z.array(StartReadinessCheckSchema),
});
export type StartReadinessRecord = z.infer<typeof StartReadinessRecordSchema>;
