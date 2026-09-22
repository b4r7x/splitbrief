import { z } from 'zod';
import {
  executableName,
  isPosixShellCommandStringOption,
} from '../trust/interpreter-command-string.js';

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
  'on_halt',
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

const FORBIDDEN_SHELL_NAMES = new Set([
  'ash',
  'bash',
  'cmd',
  'csh',
  'dash',
  'env',
  'fish',
  'ksh',
  'mksh',
  'powershell',
  'pwsh',
  'sh',
  'tcsh',
  'zsh',
]);

function isShellLauncher(value: string): boolean {
  return FORBIDDEN_SHELL_NAMES.has(executableName(value));
}

function enablesShellEvaluation(arg: string): boolean {
  return arg === '/c' || arg === '/C' || isPosixShellCommandStringOption(arg);
}

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
    if (isShellLauncher(entry.command)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inline shell '${entry.command}' is not allowed as hook command — use a script file`,
        path: ['command'],
      });
    }
    for (let i = 0; i < entry.args.length; i++) {
      const arg = entry.args[i];
      if (arg === undefined) continue;
      if (enablesShellEvaluation(arg)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `flag '${arg}' enables shell evaluation and is not allowed in hook args — use a script file`,
          path: ['args', i],
        });
      }
      if (isShellLauncher(arg)) {
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

// Nothing commits any more, so the commit events never fire: an empty legacy list loads and is
// dropped, a populated one fails the load instead of looking like an active hook.
const RETIRED_HOOK_EVENTS = ['pre_commit', 'post_commit'] as const;

export const HooksConfigSchema: z.ZodType<HooksConfig> = z
  .strictObject({
    ...hookEventConfigShape,
  })
  .superRefine((hooks, ctx) => {
    for (const event of RETIRED_HOOK_EVENTS) {
      if ((hooks[event]?.length ?? 0) === 0) continue;
      ctx.addIssue({
        code: 'custom',
        message: `${event} hooks were removed — SPLITBRIEF no longer commits, so they never run; delete hooks.${event}.`,
        path: [event],
      });
    }
  })
  .transform((hooks) => {
    const active: HooksConfig = { ...hooks };
    for (const event of RETIRED_HOOK_EVENTS) delete active[event];
    return active;
  });
