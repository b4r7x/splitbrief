import { z } from 'zod';

export const HOOK_EVENTS = [
  'pre_planning',
  'pre_task',
  'post_task',
  'pre_validation',
  'post_validation',
  'pre_commit',
  'post_commit',
  'pre_escalation',
  'on_error',
  'on_complete',
] as const;
export const HookEventSchema = z.enum(HOOK_EVENTS);
export type HookEvent = z.infer<typeof HookEventSchema>;

const FailureModeSchema = z.enum(['block', 'warn', 'ignore']);

export const HookCommandResponseSchema = z.strictObject({
  decision: z.enum(['allow', 'deny', 'warn']).optional(),
  message: z.string().optional(),
});
export type HookCommandResponse = z.infer<typeof HookCommandResponseSchema>;

export const HookOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('allow'),
    stderr: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('deny'),
    message: z.string().optional(),
    stderr: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('warn'),
    message: z.string().optional(),
    stderr: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('crash'),
    message: z.string(),
    stderr: z.string().optional(),
  }),
]);
export type HookOutcome = z.infer<typeof HookOutcomeSchema>;

const FORBIDDEN_SHELL_COMMANDS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'powershell',
  'pwsh',
  'cmd',
  'cmd.exe',
  '/bin/sh',
  '/bin/bash',
  '/bin/zsh',
  '/bin/dash',
  '/bin/fish',
  '/bin/ksh',
  '/usr/bin/env',
  '/usr/bin/bash',
  '/usr/bin/zsh',
  '/usr/bin/sh',
]);

const SHELL_EVALUATION_FLAGS = new Set(['-c', '--command', '/c', '/C']);

const HookCommandEntrySchema = z
  .strictObject({
    kind: z.literal('command').default('command'),
    name: z.string().min(1).optional(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeout_ms: z.number().int().positive().max(300_000).default(30_000),
    on_failure: FailureModeSchema.default('warn'),
  })
  .superRefine((entry, ctx) => {
    if (FORBIDDEN_SHELL_COMMANDS.has(entry.command)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inline shell '${entry.command}' is not allowed as hook command — use a script file`,
        path: ['command'],
      });
    }
    for (let i = 0; i < entry.args.length; i++) {
      const arg = entry.args[i];
      if (arg === undefined) continue;
      if (SHELL_EVALUATION_FLAGS.has(arg)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `flag '${arg}' enables shell evaluation and is not allowed in hook args — use a script file`,
          path: ['args', i],
        });
      }
      if (FORBIDDEN_SHELL_COMMANDS.has(arg)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `shell '${arg}' is not allowed in hook args — use a script file`,
          path: ['args', i],
        });
      }
    }
  });

export const HookEntrySchema = HookCommandEntrySchema;
export type HookCommandEntry = z.infer<typeof HookCommandEntrySchema>;
export type HookEntry = z.infer<typeof HookEntrySchema>;
export type HooksConfig = Partial<Record<HookEvent, HookEntry[]>>;

const hookEventConfigShape = Object.fromEntries(
  HOOK_EVENTS.map((event) => [event, z.array(HookEntrySchema).optional()]),
);

export const HooksConfigSchema: z.ZodType<HooksConfig> = z.strictObject({
  ...hookEventConfigShape,
});
