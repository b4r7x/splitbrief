import { InvalidArgumentError, type Command } from 'commander';
import { cliError } from './errors.js';
import { IMPLEMENTER_API_PROVIDER_IDS } from '../core/providers/api-provider-catalog.js';
import { IMPLEMENTER_CLI_TOOL_IDS } from '../core/runners/cli-tool-catalog.js';
import { META_PROVIDER_IDS, OutputFormatSchema, PLANNER_TOOL_IDS } from '../core/schemas/enums.js';

const IMPLEMENTER_TOOL_IDS = [
  ...IMPLEMENTER_CLI_TOOL_IDS,
  ...IMPLEMENTER_API_PROVIDER_IDS,
  ...META_PROVIDER_IDS,
];

export const ALLOW_REPO_RUNNERS_HELP =
  'Grant this run the shell/agent runner commands the project config declares (headless use)';

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

export type SeatSpec = Readonly<{ tool: string; model?: string; effort?: string }>;

/**
 * The seat grammar `<tool>[:<model>][@<effort>]` the skills already document for
 * `impl=` / `review=`: split on the first `:` and the last `@`, so a model id
 * may carry colons and the effort word is always the tail.
 */
export function parseSeatSpecOption(value: string): SeatSpec {
  const spec = value.trim();
  const at = spec.lastIndexOf('@');
  const head = at === -1 ? spec : spec.slice(0, at);
  const effort = at === -1 ? undefined : spec.slice(at + 1).trim();
  const colon = head.indexOf(':');
  const tool = (colon === -1 ? head : head.slice(0, colon)).trim();
  const model = colon === -1 ? undefined : head.slice(colon + 1).trim();
  if (tool === '') {
    throw new InvalidArgumentError(`'${value}' names no tool. Use <tool>[:<model>][@<effort>].`);
  }
  if (model === '') {
    throw new InvalidArgumentError(`'${value}' names an empty model after ':'.`);
  }
  if (effort === '') {
    throw new InvalidArgumentError(`'${value}' names an empty effort after '@'.`);
  }
  return { tool, ...(model !== undefined && { model }), ...(effort !== undefined && { effort }) };
}

/**
 * A ref reaches `git diff` as a positional argument, where a leading `-` would
 * be read as an option (`--output=<file>` writes the diff to any path). Refs
 * cannot begin with `-` anyway, so rejecting the shape here costs nothing.
 */
export function parseGitRefOption(value: string): string {
  const ref = value.trim();
  if (ref === '') {
    throw new InvalidArgumentError('a git ref cannot be empty.');
  }
  if (ref.startsWith('-')) {
    throw new InvalidArgumentError(`'${value}' is not a git ref: a ref cannot start with '-'.`);
  }
  return ref;
}

function parseEnvRefOption(value: string): string {
  return value.startsWith('env:') ? value : `env:${value}`;
}

/**
 * Every flag spelling that consumes the next argv token, read off the live
 * registrations rather than a second list: the retired-command guard has to
 * tell `--json attach x` (a retired subcommand behind a boolean flag) from
 * `--project attach` (a directory that happens to be spelled like one).
 */
export function valueTakingFlags(program: Command): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const command of [program, ...program.commands]) {
    for (const option of command.options) {
      if (!option.required && !option.optional) continue;
      if (option.short !== undefined) flags.add(option.short);
      if (option.long !== undefined) flags.add(option.long);
    }
  }
  return flags;
}

export function addWorkflowOptions(cmd: Command): Command {
  // At 80 columns the widest term (37) leaves descriptions 39 — one short of commander's
  // default minWidthToWrap of 40, below which it emits every description unwrapped and the
  // terminal breaks them mid-word. 32, not 39, so a term up to 44 columns still wraps.
  return cmd
    .configureHelp({ minWidthToWrap: 32 })
    .option('--approve <level>', 'Approval gates: none, spec, plan, all, default (follows mode)')
    .option('--model <model>', 'Override implementer model (alias for --implementer-model)')
    .option('--provider <provider>', 'Override implementer provider (alias for --implementer)')
    .option('--planner <tool>', `Planner tool (${PLANNER_TOOL_IDS.join(', ')})`)
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
    .option('--implementer <provider>', `Implementer provider (${IMPLEMENTER_TOOL_IDS.join(', ')})`)
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
    .option('--reviewer <tool>', `Reviewer tool (${PLANNER_TOOL_IDS.join(', ')})`)
    .option('--reviewer-model <model>', 'Reviewer model (for API reviewers)')
    .option('--reviewer-command <cmd>', 'Custom reviewer command (when --reviewer=shell)')
    .option('--reviewer-api-base <url>', 'Reviewer API base URL for API providers')
    .option(
      '--reviewer-api-key-env <var>',
      'Reviewer API key environment variable',
      parseEnvRefOption,
    )
    .option(
      '--reviewer-args <arg>',
      'Append reviewer CLI/shell argument (repeatable)',
      collectOption,
    )
    .option(
      '--reviewer-output-format <format>',
      'Reviewer output format: stream-json, jsonl, text, or opencode',
      parseOutputFormatOption,
    )
    .option(
      '--reviewer-context-length <tokens>',
      'Reviewer context length',
      parsePositiveIntegerOption,
    )
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--no-fullscreen', 'Disable fullscreen alternate screen buffer')
    .option('--no-mouse', 'Disable mouse tracking')
    .option('--hover', 'Enable hover highlight (opt-in; requires mouse + fullscreen)', false)
    .option('--mode <mode>', 'Workflow mode: quick, standard, or speckit')
    .option('--budget <amount>', 'Maximum budget in dollars (e.g., 2.00)', parseBudgetOption)
    .option(
      '--planner-effort <level>',
      "Planner effort hint: none, minimal, low, medium, high, xhigh, max. The seat's tool accepts a subset and reports what it rejects; dropped with a warning on seats that cannot send it.",
    )
    .option(
      '--reviewer-effort <level>',
      "Reviewer effort hint: none, minimal, low, medium, high, xhigh, max. The seat's tool accepts a subset and reports what it rejects; dropped with a warning on seats that cannot send it.",
    )
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option('--allow-repo-runners', ALLOW_REPO_RUNNERS_HELP, false)
    .option(
      '--allow-unverified-auth',
      'Allow headless start when compatible CLI authentication is unverified',
      false,
    )
    .option('--json', 'Headless mode: emit public NDJSON records to stdout, skip TUI render', false)
    .option(
      '--plain',
      'Headless mode: emit one plain line per phase, task, review and completion',
      false,
    )
    .option('--yolo', 'Skip file-write tiered approval prompts for this session', false)
    .hook('preAction', (command) => {
      assertOutputModeExclusive(command.opts<OutputModeOpts>());
    });
}

interface OutputModeOpts {
  json?: boolean | undefined;
  plain?: boolean | undefined;
}

/**
 * `--plain` and `--json` are two renderings of the same headless stream and
 * cannot share one stdout. The pair needs its own guard.
 */
function assertOutputModeExclusive(opts: Readonly<OutputModeOpts>): void {
  if (opts.json === true && opts.plain === true) {
    throw cliError('--plain and --json cannot be combined; choose one output mode.', 2);
  }
}
