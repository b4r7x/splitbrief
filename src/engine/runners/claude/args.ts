import type { EffortLevel } from '../../../core/schemas/enums.js';
import { CLI_PROMPT_SENTINEL } from '../cli-tools/candidate-contract.js';
import { claudeCodePlannerAdapter } from '../cli-tools/claude-code.js';
import { error } from '../../../utils/error.js';

export interface BuildArgsOpts {
  projectDir: string;
  mode: 'plan' | 'escalate';
  sessionId?: string | null;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
}

/**
 * The claude-code adapter owns this argv, so the run, the readiness arg-vector
 * preflight and the protected-flag guard all read one vector: configured
 * `planner.args` ride behind the adapter's base args, and the adapter's own
 * validation rejects a configured flag that fights that base.
 */
export function buildClaudeArgs(opts: BuildArgsOpts): string[] {
  const configuredArgs = opts.configuredArgs ?? [];
  const baseArgs = [
    ...claudeCodePlannerAdapter.baseArgs({
      prompt: CLI_PROMPT_SENTINEL,
      model: opts.model,
      projectDir: opts.projectDir,
      configuredArgs,
      mode: opts.mode,
      sessionId: opts.sessionId ?? null,
      effort: opts.effort,
    }),
  ];
  const args = [...baseArgs, ...configuredArgs];
  const validation = claudeCodePlannerAdapter.validateArgs({
    invocationArgs: args,
    baseArgs: baseArgs,
  });
  if (!validation.valid) {
    throw error(
      'cli-argument-conflict',
      `Configured Claude Code arguments conflict with the invocation SPLITBRIEF owns: ${validation.conflicts.join(', ')}`,
      { tool: 'claude-code', conflicts: validation.conflicts },
    );
  }
  return args;
}
