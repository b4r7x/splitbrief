import { z } from 'zod';

export const AnalyzeResultSchema = z.object({
  specTaskCoverage: z.number(),
  planTaskCoverage: z.number(),
  orphanTasks: z.array(z.string()),
  unaddressedSpecSections: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
});
export type AnalyzeResult = z.infer<typeof AnalyzeResultSchema>;
