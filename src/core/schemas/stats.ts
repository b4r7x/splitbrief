import { z } from 'zod';

export const StatsSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  totalSessions: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
  totalSavings: z.number().nonnegative(),
  totalHypotheticalCost: z.number().nonnegative(),
  averageSavingsPercentage: z.number().nonnegative(),
  totalTasks: z.number().int().nonnegative(),
  totalLocalTasks: z.number().int().nonnegative(),
  totalEscalatedTasks: z.number().int().nonnegative(),
  providerTotals: z.record(
    z.string(),
    z.object({
      cost: z.number().nonnegative(),
      sessions: z.number().int().nonnegative(),
    }),
  ),
});

export type Stats = z.infer<typeof StatsSchema>;

export function emptyStats(): Stats {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    totalSessions: 0,
    totalCost: 0,
    totalSavings: 0,
    totalHypotheticalCost: 0,
    averageSavingsPercentage: 0,
    totalTasks: 0,
    totalLocalTasks: 0,
    totalEscalatedTasks: 0,
    providerTotals: {},
  };
}
