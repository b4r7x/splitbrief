import { z } from 'zod';
import { TaskIdSchema } from './task.js';

export const PLANNER_CALLS = [
  'research',
  'spec',
  'plan',
  'tasks',
  'clarify',
  'constitution',
  'analyze',
] as const;
export const PlannerCallSchema = z.enum(PLANNER_CALLS);
export type PlannerCall = z.infer<typeof PlannerCallSchema>;

export const GATE_NAMES = ['spec', 'plan', 'briefs'] as const;
export const GateNameSchema = z.enum(GATE_NAMES);
export type GateName = z.infer<typeof GateNameSchema>;

export const STOP_KINDS = [
  'paused',
  'waiting',
  'halted',
  'failed',
  'interrupted',
  'input-required',
] as const;
export const StopKindSchema = z.enum(STOP_KINDS);
export type StopKind = z.infer<typeof StopKindSchema>;

/**
 * Where a stop landed: inside the call it cut, or on a boundary where it cut nothing — between two
 * briefs, or at a gate, which runs no call.
 */
export const STEP_CUTS = ['mid-step', 'boundary'] as const;
export const StepCutSchema = z.enum(STEP_CUTS);
export type StepCut = z.infer<typeof StepCutSchema>;

export const StepRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('planner'), call: PlannerCallSchema }),
  z.object({ kind: z.literal('gate'), gate: GateNameSchema }),
  z.object({
    kind: z.literal('brief'),
    taskId: TaskIdSchema,
    attempt: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('review'), cycle: z.number().int().nonnegative() }),
]);

export type StepRef = z.infer<typeof StepRefSchema>;
