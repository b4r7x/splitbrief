import type { z } from 'zod';
import type {
  RunnerCallContextSchema,
  RunnerCallErrorSchema,
  RunnerCallEventSchema,
  RunnerCallFailureStatusSchema,
  RunnerCallResultSchema,
  RunnerCallStatusSchema,
  RunnerCallUsageSchema,
  RunnerCallUsageSemanticsSchema,
  RunnerCallWarningSchema,
} from './schema.js';

export type RunnerCallStatus = z.infer<typeof RunnerCallStatusSchema>;
export type RunnerCallFailureStatus = z.infer<typeof RunnerCallFailureStatusSchema>;
export type RunnerCallUsageSemantics = z.infer<typeof RunnerCallUsageSemanticsSchema>;

export type RunnerCallContext = z.infer<typeof RunnerCallContextSchema>;
export type RunnerCallUsage = z.infer<typeof RunnerCallUsageSchema>;
export type RunnerCallError = z.infer<typeof RunnerCallErrorSchema>;
export type RunnerCallWarningInput = z.input<typeof RunnerCallWarningSchema>;
export type RunnerCallWarning = z.infer<typeof RunnerCallWarningSchema>;
export type RunnerCallEventInput = z.input<typeof RunnerCallEventSchema>;
export type RunnerCallEvent = z.infer<typeof RunnerCallEventSchema>;
export type RunnerCallResult = z.infer<typeof RunnerCallResultSchema>;
