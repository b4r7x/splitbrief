import { z } from 'zod';

export const HookEventSchema = z.enum([
  'pre_planning',
  'post_planning',
  'pre_task',
  'post_task',
  'pre_validation',
  'post_validation',
  'pre_commit',
  'post_commit',
  'pre_escalation',
  'pre_compact',
  'on_error',
  'on_complete',
]);
export type HookEvent = z.infer<typeof HookEventSchema>;

const FailureModeSchema = z.enum(['block', 'warn', 'ignore']);

const HookCommandEntrySchema = z
  .object({
    kind: z.literal('command').default('command'),
    name: z.string().min(1).optional(),
    command: z
      .string()
      .min(1)
      .refine(
        (cmd) =>
          cmd !== 'sh' && cmd !== 'bash' && cmd !== '/bin/sh' && cmd !== '/bin/bash',
        { message: 'inline shell (sh/bash) is not allowed as hook command — use a script file' },
      ),
    args: z.array(z.string()).default([]),
    timeout_ms: z.number().int().positive().max(300_000).default(30_000),
    on_failure: FailureModeSchema.default('warn'),
  })
  .strict();

const HookModuleEntrySchema = z
  .object({
    kind: z.literal('module'),
    name: z.string().min(1).optional(),
    path: z.string().min(1),
    timeout_ms: z.number().int().positive().max(300_000).default(30_000),
    on_failure: FailureModeSchema.default('warn'),
  })
  .strict();

function isObjectWithoutKind(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !('kind' in value);
}

export const HookEntrySchema = z.preprocess(
  (val) =>
    isObjectWithoutKind(val)
      ? { ...val, kind: 'command' }
      : val,
  z.discriminatedUnion('kind', [HookCommandEntrySchema, HookModuleEntrySchema]),
);
export type HookCommandEntry = z.infer<typeof HookCommandEntrySchema>;
export type HookModuleEntry = z.infer<typeof HookModuleEntrySchema>;
export type HookEntry = z.infer<typeof HookEntrySchema>;

export const HooksConfigSchema = z
  .object({
    builtin: z.record(z.string(), z.boolean()).optional(),
    pre_planning: z.array(HookEntrySchema).optional(),
    post_planning: z.array(HookEntrySchema).optional(),
    pre_task: z.array(HookEntrySchema).optional(),
    post_task: z.array(HookEntrySchema).optional(),
    pre_validation: z.array(HookEntrySchema).optional(),
    post_validation: z.array(HookEntrySchema).optional(),
    pre_commit: z.array(HookEntrySchema).optional(),
    post_commit: z.array(HookEntrySchema).optional(),
    pre_escalation: z.array(HookEntrySchema).optional(),
    pre_compact: z.array(HookEntrySchema).optional(),
    on_error: z.array(HookEntrySchema).optional(),
    on_complete: z.array(HookEntrySchema).optional(),
  })
  .strict();
export type HooksConfig = z.infer<typeof HooksConfigSchema>;
