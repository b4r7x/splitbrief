import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, initConfig, configPath } from '../core/config/index.js';
import { isGitRepo } from '../utils/git.js';
import { TINY_SPEC_DIR, CONFIG_FILE } from '../core/paths.js';
import { cliError } from './errors.js';
import { toErrorMessage } from '../utils/format.js';
import type { WorkflowOpts } from '../types.js';

const NO_CONFIG_MSG = `No config found. Creating default ${TINY_SPEC_DIR}/${CONFIG_FILE}`;

export function addWorkflowOptions(cmd: Command): Command {
  return cmd
    .option('--auto', 'Auto-approve spec and plan')
    .option('--model <model>', 'Override implementer model (alias for --implementer-model)')
    .option('--provider <provider>', 'Override implementer provider (alias for --implementer)')
    .option('--planner <tool>', 'Planner tool (claude-code, codex, opencode, aider, copilot, kilo-code, agent-sdk, anthropic, openrouter, shell)')
    .option('--planner-model <model>', 'Planner model (for API planners)')
    .option('--planner-command <cmd>', 'Custom planner command (when --planner=shell)')
    .option('--implementer <provider>', 'Implementer provider (ollama, lm-studio, deepseek, openrouter, claude-code, codex, opencode, aider, copilot, kilo-code, shell)')
    .option('--implementer-model <model>', 'Implementer model')
    .option('--implementer-command <cmd>', 'Custom implementer command (when --implementer=shell)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--no-fullscreen', 'Disable fullscreen alternate screen buffer')
    .option('--mode <mode>', 'Workflow mode: quick, standard, or full')
    .option('--budget <amount>', 'Maximum budget in dollars (e.g., 2.00)', parseFloat);
}

export function resolveProjectDir(dir?: string): string {
  return resolve(dir ?? process.cwd());
}

export function loadConfigOrExit(projectDir: string): ReturnType<typeof loadConfig> {
  try {
    return loadConfig(projectDir);
  } catch (err) {
    throw cliError(toErrorMessage(err), 2);
  }
}

async function assertGitRepo(projectDir: string): Promise<void> {
  if (!(await isGitRepo(projectDir))) {
    throw cliError('Error: not a git repository. Run `git init` first.', 1);
  }
}

export async function ensureGitAndConfig(projectDir: string): Promise<void> {
  await assertGitRepo(projectDir);

  if (!existsSync(configPath(projectDir))) {
    console.log(NO_CONFIG_MSG);
    initConfig(projectDir);
  }
}

export interface SetupResult {
  projectDir: string;
  useFullscreen: boolean;
  needsSetup?: boolean | undefined;
}

function hasWorkflowOverrides(opts: WorkflowOpts): boolean {
  return opts.model !== undefined
    || opts.provider !== undefined
    || opts.planner !== undefined
    || opts.plannerModel !== undefined
    || opts.plannerCommand !== undefined
    || opts.implementer !== undefined
    || opts.implementerModel !== undefined
    || opts.implementerCommand !== undefined
    || opts.mode !== undefined
    || opts.auto === true
    || opts.budget !== undefined;
}

export async function setupWorkflow(opts: WorkflowOpts): Promise<SetupResult> {
  const projectDir = resolveProjectDir(opts.project);

  await assertGitRepo(projectDir);

  const isInteractive = process.stdout.isTTY && !process.env['CI'];
  const useFullscreen = opts.fullscreen !== false && isInteractive;

  const hasOverrides = hasWorkflowOverrides(opts);
  if (!existsSync(configPath(projectDir))) {
    if (hasOverrides) {
      console.log(NO_CONFIG_MSG);
      initConfig(projectDir);
    } else {
      initConfig(projectDir);
      return { projectDir, useFullscreen, needsSetup: true };
    }
  }

  return { projectDir, useFullscreen };
}
