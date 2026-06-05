import { InvalidArgumentError, type Command } from 'commander';
import { cliError } from './errors.js';

function collectOption(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`'${value}' is not a valid number.`);
  }
  return parsed;
}

function parseEnvRefOption(value: string): string {
  return value.startsWith('env:') ? value : `env:${value}`;
}

export function assertModeFlagsExclusive(opts: { json?: boolean; rpc?: boolean }): void {
  if (opts.json && opts.rpc) throw cliError('--json and --rpc cannot be combined');
}

export function addWorkflowOptions(cmd: Command): Command {
  return cmd
    .option('--auto', 'Auto-approve spec and plan (alias for --approve none)')
    .option('--approve <level>', 'Approval gates: none, spec, plan, all, default (follows mode)')
    .option('--model <model>', 'Override implementer model (alias for --implementer-model)')
    .option('--provider <provider>', 'Override implementer provider (alias for --implementer)')
    .option(
      '--planner <tool>',
      'Planner tool (claude-code, codex, opencode, aider, copilot, kilo-code, agent-sdk, anthropic, openrouter, shell)',
    )
    .option('--planner-model <model>', 'Planner model (for API planners)')
    .option('--planner-command <cmd>', 'Custom planner command (when --planner=shell)')
    .option('--planner-api-base <url>', 'Planner API base URL for API providers')
    .option(
      '--planner-api-key-env <var>',
      'Planner API key environment variable',
      parseEnvRefOption,
    )
    .option('--planner-args <arg>', 'Append planner CLI/shell argument (repeatable)', collectOption)
    .option(
      '--planner-output-format <format>',
      'Planner output format: stream-json, jsonl, text, or opencode',
    )
    .option('--planner-context-length <tokens>', 'Planner context length', parseNumberOption)
    .option(
      '--implementer <provider>',
      'Implementer provider (ollama, lm-studio, deepseek, openrouter, claude-code, codex, opencode, aider, copilot, kilo-code, shell)',
    )
    .option('--implementer-model <model>', 'Implementer model')
    .option('--implementer-command <cmd>', 'Custom implementer command (when --implementer=shell)')
    .option('--implementer-api-base <url>', 'Implementer API base URL for API providers')
    .option(
      '--implementer-api-key-env <var>',
      'Implementer API key environment variable',
      parseEnvRefOption,
    )
    .option(
      '--implementer-args <arg>',
      'Append implementer CLI/shell argument (repeatable)',
      collectOption,
    )
    .option(
      '--implementer-output-format <format>',
      'Implementer output format: stream-json, jsonl, text, or opencode',
    )
    .option(
      '--implementer-context-length <tokens>',
      'Implementer context length',
      parseNumberOption,
    )
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--no-fullscreen', 'Disable fullscreen alternate screen buffer')
    .option('--no-mouse', 'Disable mouse tracking')
    .option(
      '--mode <mode>',
      'Workflow mode: instant, quick, standard, or speckit (full=speckit alias)',
    )
    .option('--budget <amount>', 'Maximum budget in dollars (e.g., 2.00)', parseFloat)
    .option(
      '--planner-effort <level>',
      'Planner effort hint: low, medium, high, xhigh. Dropped on unsupported backends.',
    )
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option(
      '--json',
      'Headless mode: emit each EngineEvent as NDJSON to stdout, skip TUI render',
      false,
    )
    .option('--rpc', 'RPC mode: bidirectional NDJSON on stdin/stdout', false)
    .option(
      '--otel-exporter <name>',
      'Bootstrap an OTel exporter (currently only "console"); requires otel.enabled in config',
    )
    .option('--worktree [name]', 'run in a new linked git worktree (.trees/<name>)')
    .option('--yolo', 'Skip action-level tiered approval prompts for this session', false);
}
