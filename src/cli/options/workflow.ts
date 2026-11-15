import type { Command } from 'commander';
import {
  isListedApiProvider,
  IMPLEMENTER_API_PROVIDER_IDS,
} from '../../core/providers/api-catalog.js';
import { isListedCliTool, IMPLEMENTER_CLI_TOOL_IDS } from '../../core/runners/cli-tool/catalog.js';
import { PLANNER_TOOL_IDS, META_PROVIDER_IDS } from '../../core/schemas/enums.js';
import { cliError } from '../errors.js';
import { parseSkillIdsOption } from './skills.js';
import { parseContinueActionOption } from './continue-action.js';
import { parseEnvRefOption } from './parsers.js';
import { parseSeatDownPolicyOption } from './parsers.js';
import { collectOption, parseOutputFormatOption, parsePositiveIntegerOption } from './parsers.js';

function isListedRunnerId(id: string): boolean {
  return isListedCliTool(id) && isListedApiProvider(id);
}

const LISTED_PLANNER_TOOL_IDS = PLANNER_TOOL_IDS.filter(isListedRunnerId);

const LISTED_IMPLEMENTER_TOOL_IDS = [
  ...IMPLEMENTER_CLI_TOOL_IDS,
  ...IMPLEMENTER_API_PROVIDER_IDS,
  ...META_PROVIDER_IDS,
].filter(isListedRunnerId);

export const ALLOW_REPO_RUNNERS_HELP =
  'Grant this run the shell/agent runner commands the project config declares (headless use)';

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
  cmd
    .configureHelp({ minWidthToWrap: 32 })
    .option('--model <model>', 'Override implementer model (alias for --implementer-model)')
    .option('--provider <provider>', 'Override implementer provider (alias for --implementer)')
    .option(
      '--planner <tool>',
      `Planner tool or API provider; a CLI tool id always selects the CLI (custom API providers are YAML-only) (${LISTED_PLANNER_TOOL_IDS.join(', ')})`,
    )
    .option('--planner-model <model>', 'Planner model (CLI and API planners)')
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
      `Implementer provider or CLI tool; a CLI tool id always selects the CLI (custom API providers are YAML-only) (${LISTED_IMPLEMENTER_TOOL_IDS.join(', ')})`,
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
    .option(
      '--reviewer <tool>',
      `Reviewer tool or API provider; a CLI tool id always selects the CLI (custom API providers are YAML-only) (${LISTED_PLANNER_TOOL_IDS.join(', ')})`,
    )
    .option('--reviewer-model <model>', 'Reviewer model (CLI and API reviewers)')
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
    .option(
      '--planner-effort <level>',
      "Planner effort hint: off, none, minimal, low, medium, high, xhigh, max, ultra. The seat's tool accepts a subset and reports what it rejects; dropped with a warning on seats that cannot send it.",
    )
    .option(
      '--reviewer-effort <level>',
      "Reviewer effort hint: off, none, minimal, low, medium, high, xhigh, max, ultra. The seat's tool accepts a subset and reports what it rejects; dropped with a warning on seats that cannot send it.",
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
    .option(
      '--skills <ids>',
      'Attach project/global skills to every seat (comma-separated ids)',
      parseSkillIdsOption,
    );
  if (cmd.name() === 'continue') {
    cmd.option(
      '--action <action>',
      'skip, retry, restore, switch-seat:<tool>[:<model>][@<effort>], accept-as-is, or end-run answer recovery; apply, apply-as-is and discard settle a run that is ready to apply',
      parseContinueActionOption,
    );
  }
  return cmd
    .option(
      '--on-seat-down <policy>',
      "Headless: halt on a seat-down, or switch to the seat's declared fallback (halt|switch)",
      parseSeatDownPolicyOption,
    )
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
