import { z } from 'zod';

export const StructuredSummarySchema = z.object({
  goal: z.string(),
  stepsCompleted: z.array(z.string()),
  currentStep: z.string(),
  filesModified: z.array(z.string()),
  constraintsDiscovered: z.array(z.string()),
  remainingWork: z.array(z.string()),
});
export type StructuredSummary = z.infer<typeof StructuredSummarySchema>;

export const CompactionFormatSchema = z.enum(['auto', 'freeform', 'structured']);
export type CompactionFormat = z.infer<typeof CompactionFormatSchema>;
export type ResolvedCompactionFormat = Exclude<CompactionFormat, 'auto'>;

export function resolveCompactionFormat(
  configured: CompactionFormat,
  plannerKind: string,
): ResolvedCompactionFormat {
  if (configured === 'freeform') return 'freeform';
  if (configured === 'structured') return 'structured';
  return plannerKind === 'api' || plannerKind === 'agent-sdk' ? 'structured' : 'freeform';
}

export function tryParseStructuredSummary(text: string): StructuredSummary | null {
  try {
    const parsed = JSON.parse(text);
    const result = StructuredSummarySchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
