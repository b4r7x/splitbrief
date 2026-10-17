import type { Config } from '../../../core/schemas/config.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import {
  readManifestCommands,
  type ManifestCommands,
} from '../../../core/validation/manifest-commands.js';
import { detectFormatFixCommand } from '../../../core/validation/lint-detection.js';
import { buildTestArgs, detectStack } from '../../../core/validation/stacks/registry.js';
import type { Stack } from '../../../core/validation/stacks/types.js';
import {
  resolveTestCommand,
  type ResolvedCommand,
} from '../../../core/validation/stage-command.js';
import { STAGE_TIMEOUT_MS } from '../../../core/pipeline-spec/gates.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { runCommand } from '../../../lib/process/spawn/run-command.js';
import { labelError } from '../../../utils/format-errors.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import type { EventBus } from '../../events/types.js';
import { publishWarning } from '../events.js';
import { sanitizeDiscoveredValidation } from '../planning/sanitize-discovered-validation.js';
import { fingerprintFiles } from '../changed-files-baseline.js';
import { formatValidationCommand, resolveTestTarget } from './commands.js';
import type {
  FormatChangedFilesOptions,
  ValidationCommandRunner,
  Validator,
  ValidatorDeps,
} from './types.js';

function resolveValidationTimeout(config: Config): number {
  return config.validation.timeoutMs ?? STAGE_TIMEOUT_MS;
}

type StageContext = {
  projectDir: string;
  config: Config;
  manifest: ManifestCommands;
  discovered: DiscoveredValidation | undefined;
  stack: Stack | null;
};

type TestCheckPlan =
  | {
      kind: 'run';
      resolved: ResolvedCommand;
      args: string[];
      command: string;
      /** A cargo selection passes only when its output shows a test that ran. */
      countsCargoTests: boolean;
    }
  | { kind: 'skip'; reason: string };

export function buildStageContext(input: {
  projectDir: string;
  config: Config;
  discoveredValidation: DiscoveredValidation | undefined;
  notices: { bus: EventBus; phase: Phase };
}): StageContext {
  const { projectDir, config, discoveredValidation, notices } = input;
  const manifest = readManifestCommands(projectDir);
  const stack = detectStack(projectDir, config.validation.stack);
  return {
    projectDir,
    config,
    manifest,
    discovered: sanitizeDiscoveredValidation(discoveredValidation, notices, {
      projectDir,
      config,
      manifest,
      stack,
    }),
    stack,
  };
}

const FORMATTABLE_FILE = /\.(c|m)?[jt]sx?$|\.(json|jsonc|css)$/;

type FormatWarning = {
  message: string;
  safety: { category: 'validation'; code: 'validation_formatted' | 'validation_format_failed' };
};

// Layout the implementer left unformatted fails the project's linter, so the project's own
// formatter runs first. Only the brief's own changed files are rewritten: nothing outside its
// scope mutates and change attribution holds.
async function formatFiles(opts: {
  projectDir: string;
  config: Config;
  changedFiles: readonly string[];
  runCommand: ValidationCommandRunner;
  signal: AbortSignal | undefined;
}): Promise<FormatWarning | undefined> {
  const command = detectFormatFixCommand(opts.projectDir);
  if (command === null) return undefined;
  const formattable = opts.changedFiles.filter((file) => FORMATTABLE_FILE.test(file));
  const before = await fingerprintFiles(opts.projectDir, formattable);
  // A file the brief deleted is not handed over: the formatter fails the whole pass on a missing path.
  const files = formattable.filter((file) => before.get(file) !== 'missing');
  if (files.length === 0) return undefined;
  const parts = parseShellCommand(command);
  const cmd = parts[0];
  if (cmd === undefined) return undefined;
  try {
    await opts.runCommand(cmd, [...parts.slice(1), ...files], {
      cwd: opts.projectDir,
      timeout: resolveValidationTimeout(opts.config),
      label: 'format',
      signal: opts.signal,
    });
  } catch (err) {
    return {
      message: labelError(
        `Formatting the changed files with ${command} failed; the checks still run`,
        err,
      ),
      safety: { category: 'validation', code: 'validation_format_failed' },
    };
  }
  const after = await fingerprintFiles(opts.projectDir, files);
  const rewritten = files.filter((file) => before.get(file) !== after.get(file));
  if (rewritten.length === 0) return undefined;
  return {
    message: `Formatted ${rewritten.length} file(s) with ${command}: ${rewritten.join(', ')}`,
    safety: { category: 'validation', code: 'validation_formatted' },
  };
}

/** The command a planner `test` check runs on its file, narrowed when the stack can select it. */
export function planTestCheck(file: string, ctx: StageContext): TestCheckPlan {
  const resolved = resolveTestCommand(ctx);
  if (resolved === null)
    return { kind: 'skip', reason: 'no test command for an unrecognised stack' };
  const target = resolveTestTarget({
    resolved,
    files: [file],
    projectDir: ctx.projectDir,
    config: ctx.config,
    discovered: ctx.discovered,
    stack: ctx.stack,
  });
  if (!target.run) return { kind: 'skip', reason: target.skipReason };
  const narrowing = ctx.stack?.narrowing ?? { kind: 'none' };
  const args = buildTestArgs(resolved, target.targets, narrowing, ctx.projectDir);
  if (args === null) return { kind: 'skip', reason: 'no single cargo command runs these tests' };
  return {
    kind: 'run',
    resolved,
    args,
    command: formatValidationCommand(resolved.cmd, args),
    countsCargoTests: narrowing.kind === 'cargo-target' && target.targets.length > 0,
  };
}

export function createValidator(deps: ValidatorDeps = {}): Validator {
  const commandRunner = deps.runCommand ?? runCommand;
  async function formatChangedFiles(opts: FormatChangedFilesOptions): Promise<void> {
    if (opts.changedFiles.length === 0) return;
    const warning = await formatFiles({
      projectDir: opts.projectDir,
      config: opts.config,
      changedFiles: opts.changedFiles,
      runCommand: commandRunner,
      signal: opts.signal,
    });
    if (warning !== undefined)
      publishWarning({ bus: opts.bus, phase: opts.phase, taskId: opts.task.id, ...warning });
  }

  return { formatChangedFiles };
}
