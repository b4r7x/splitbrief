import { z } from 'zod';
import type { OutputFormat, RunnerKind } from '../../schemas/enums.js';
import { RUNNER_IDLE_WARN_MS } from '../../schemas/runner/fields.js';
import type {
  ImplementerConfig,
  ImplementerProfileConfig,
} from '../../schemas/runner/implementer.js';
import type { PlannerConfig } from '../../schemas/runner/planner.js';

export function defaultedIdleWarnMs(value: number | undefined): number {
  return value ?? RUNNER_IDLE_WARN_MS;
}

export const CustomCommandContractSchema = z.enum(['output', 'direct']);
export type CustomCommandContract = z.infer<typeof CustomCommandContractSchema>;

export type CustomCommandRunnerKind = Extract<RunnerKind, 'shell' | 'agent'>;

export function contractForRunnerKind(kind: CustomCommandRunnerKind): CustomCommandContract {
  return kind === 'shell' ? 'output' : 'direct';
}

export type CustomCommandRunner = Extract<
  PlannerConfig | ImplementerConfig | ImplementerProfileConfig,
  { kind: 'shell' | 'agent' }
>;

export type CustomCommandExecutionTuple = Readonly<{
  contract: CustomCommandContract;
  executable: string;
  argv: readonly string[];
  outputFormat: OutputFormat;
  idleWarnMs: number;
  idleKillMs?: number | undefined;
  maxToolCalls?: number | undefined;
  env: readonly string[];
}>;

type CustomCommandTupleInput = Readonly<{
  id?: string | undefined;
  contract: CustomCommandContract;
  executable: string;
  argv?: readonly string[] | undefined;
  outputFormat?: OutputFormat | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
  maxToolCalls?: number | undefined;
  env?: readonly string[] | undefined;
}>;

export function customCommandTuple(input: CustomCommandTupleInput): CustomCommandExecutionTuple {
  return {
    contract: input.contract,
    executable: input.executable,
    argv: [...(input.argv ?? [])],
    outputFormat: input.outputFormat ?? 'text',
    idleWarnMs: defaultedIdleWarnMs(input.idleWarnMs),
    ...(input.idleKillMs !== undefined && { idleKillMs: input.idleKillMs }),
    ...(input.maxToolCalls !== undefined && { maxToolCalls: input.maxToolCalls }),
    env: [...(input.env ?? [])].sort(),
  };
}

export function isCustomCommandRunner(
  runner: PlannerConfig | ImplementerConfig | ImplementerProfileConfig,
): runner is CustomCommandRunner {
  return runner.kind === 'shell' || runner.kind === 'agent';
}

export function customCommandTupleForRunner(
  runner: CustomCommandRunner,
): CustomCommandExecutionTuple {
  return customCommandTuple({
    contract: contractForRunnerKind(runner.kind),
    executable: runner.command,
    argv: runner.args,
    outputFormat: runner.outputFormat,
    idleWarnMs: runner.idleWarnMs,
    idleKillMs: runner.idleKillMs,
    maxToolCalls: runner.maxToolCalls,
    env: runner.env,
  });
}

export function customCommandTupleKey(tuple: CustomCommandExecutionTuple): string {
  return JSON.stringify(tuple);
}

export function isSameCustomCommandTuple(
  input: Readonly<{
    left: CustomCommandTupleInput;
    right: CustomCommandTupleInput;
  }>,
): boolean {
  return (
    customCommandTupleKey(customCommandTuple(input.left)) ===
    customCommandTupleKey(customCommandTuple(input.right))
  );
}
