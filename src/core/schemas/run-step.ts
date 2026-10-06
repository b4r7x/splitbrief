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

/** The two states an open run rests in; see `StopReason`. */
export const STOP_KINDS = ['waiting-for-you', 'stopped'] as const;
/** Older rows named the stop itself; each reads as the state it put the run in. */
const SAVED_STOP_KINDS: Readonly<Record<string, (typeof STOP_KINDS)[number]>> = {
  'input-required': 'waiting-for-you',
  waiting: 'waiting-for-you',
  halted: 'waiting-for-you',
  paused: 'stopped',
  failed: 'stopped',
  interrupted: 'stopped',
};
export const StopKindSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (SAVED_STOP_KINDS[value] ?? value) : value),
  z.enum(STOP_KINDS),
);
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
  z.object({ kind: z.literal('apply') }),
]);

export type StepRef = z.infer<typeof StepRefSchema>;
