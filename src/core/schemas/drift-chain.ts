import { z } from 'zod';
import { TaskIdSchema } from './task.js';

export const DriftChainEntrySchema = z.object({
  taskId: TaskIdSchema,
  outOfBoundsFiles: z.array(z.string()),
});

export const ActiveDriftChainSchema = z.object({
  entries: z.array(DriftChainEntrySchema),
  uniqueFiles: z.array(z.string()),
  score: z.number().min(0).max(1),
});

export const EmittedChainSchema = z.object({
  chainLength: z.number().int().positive(),
  score: z.number().min(0).max(1),
  uniqueOutOfBoundsFiles: z.array(z.string()),
  representativePath: z.string(),
  detectedAtTaskId: TaskIdSchema,
  ts: z.number(),
});

export const DriftChainStateSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  activeChain: ActiveDriftChainSchema,
  emittedChains: z.array(EmittedChainSchema),
});

export type ActiveDriftChain = z.infer<typeof ActiveDriftChainSchema>;
export type EmittedChain = z.infer<typeof EmittedChainSchema>;
export type DriftChainState = z.infer<typeof DriftChainStateSchema>;
