import { InvalidArgumentError, type Command } from 'commander';
import { OutputFormatSchema } from '../core/schemas/enums.js';
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

export function parsePositiveIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`'${value}' must be a positive integer.`);
  }
  return parsed;
}

export function parseBudgetOption(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidArgumentError(`'${value}' is not a valid budget amount.`);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`'${value}' must be a positive number.`);
  }
  return parsed;
}

export function parseOutputFormatOption(value: string): string {
  const parsed = OutputFormatSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(
      `'${value}' is not a valid output format. Must be one of: ${OutputFormatSchema.options.join(', ')}.`,
    );
  }
  return parsed.data;
}

function parseEnvRefOption(value: string): string {
  return value.startsWith('env:') ? value : `env:${value}`;
}

export function assertModeFlagsExclusive(opts: { json?: boolean; rpc?: boolean }): void {
  if (opts.json && opts.rpc) throw cliError('--json and --rpc cannot be combined');
}

export function assertWorktreeStartOnly(opts: { worktree?: string }): void {
  if (opts.worktree !== undefined) {
    throw cliError(
      '--worktree is only supported by `splitbrief start`; a resumed session already lives in its original worktree.',
    );
  }
}

export function addWorkflowOptions(cmd: Command): Command {
  return cmd
    .option('--approve <level>', 'Approval gates: none, spec, plan, all, default (follows mode)')
    .option('--model <model>', 'Override implementer model (alias for --implementer-model)')
    .option('--provider <provider>', 'Override implementer provider (alias for --implementer)')
    .option(
      '--planner <tool>',
      'Planner tool (claude-code, codex, opencode, aider, copilot, kilo-code, anthropic, openai, groq, together, deepseek, openrouter, shell, agent, agent-sdk)',
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
      parseOutputFormatOption,
    )
    .option(
      '--planner-context-length <tokens>',
      'Planner context length',
      parsePositiveIntegerOption,
    )
    .option(
      '--implementer <provider>',
      'Implementer provider (ollama, lm-studio, anthropic, openai, groq, together, deepseek, openrouter, claude-code, codex, opencode, aider, copilot, kilo-code, shell, agent, agent-sdk)',
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
      parseOutputFormatOption,
    )
    .option(
      '--implementer-context-length <tokens>',
      'Implementer context length',
      parsePositiveIntegerOption,
    )
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--no-fullscreen', 'Disable fullscreen alternate screen buffer')
    .option('--no-mouse', 'Disable mouse tracking')
    .option('--hover', 'Enable hover highlight (opt-in; requires mouse + fullscreen)', false)
    .option('--mode <mode>', 'Workflow mode: instant, quick, standard, or speckit')
    .option('--budget <amount>', 'Maximum budget in dollars (e.g., 2.00)', parseBudgetOption)
    .option(
      '--planner-effort <level>',
      'Planner effort hint: low, medium, high, xhigh. Dropped on unsupported backends.',
    )
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option(
      '--allow-repo-runners',
      'Trust repo-local shell/agent runner commands from project config',
      false,
    )
    .option('--json', 'Headless mode: emit public NDJSON records to stdout, skip TUI render', false)
    .option('--rpc', 'RPC mode: bidirectional NDJSON on stdin/stdout', false)
    .option(
      '--otel-exporter <name>',
      'Bootstrap an OTel exporter (currently only "console"); requires otel.enabled in config',
    )
    .option('--worktree [name]', 'run in a new linked git worktree (.trees/<name>)')
    .option('--yolo', 'Skip file-write tiered approval prompts for this session', false);
}
