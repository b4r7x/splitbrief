import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, initConfig, configPath } from '../core/config.js';
import { detectCapabilities } from '../engine/providers.js';
import { isGitRepo } from '../utils/git.js';
import { runPicker } from './picker.js';

export interface WorkflowOpts {
  auto: boolean;
  model?: string;
  provider?: string;
  planner?: string;
  plannerModel?: string;
  project?: string;
  fullscreen?: boolean;
}

export function addWorkflowOptions(cmd: Command): Command {
  return cmd
    .option('--auto', 'Auto-approve spec and plan', false)
    .option('--model <model>', 'Override implementer model')
    .option('--provider <provider>', 'Override implementer provider')
    .option('--planner <provider>', 'Override planner backend (claude-code, codex, opencode, aider, agent-sdk)')
    .option('--planner-model <model>', 'Override planner model')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--no-fullscreen', 'Disable fullscreen alternate screen buffer');
}

export function resolveProjectDir(dir?: string): string {
  return resolve(dir ?? process.cwd());
}

export function loadConfigOrExit(projectDir: string): ReturnType<typeof loadConfig> {
  try {
    return loadConfig(projectDir);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}

export async function ensureGitAndConfig(projectDir: string): Promise<void> {
  if (!(await isGitRepo(projectDir))) {
    console.error('Error: not a git repository. Run `git init` first.');
    process.exit(1);
  }

  if (!existsSync(configPath(projectDir))) {
    console.log('No config found. Creating default .tiny-spec/config.yaml');
    initConfig(projectDir);
  }
}

export async function setupWorkflow(opts: WorkflowOpts): Promise<{ projectDir: string; config: ReturnType<typeof loadConfig>; useFullscreen: boolean }> {
  const projectDir = resolveProjectDir(opts.project);

  if (!(await isGitRepo(projectDir))) {
    console.error('Error: not a git repository. Run `git init` first.');
    process.exit(1);
  }

  const hasOverrides = !!(opts.model || opts.provider || opts.planner);
  if (!existsSync(configPath(projectDir))) {
    if (hasOverrides) {
      console.log('No config found. Creating default .tiny-spec/config.yaml');
      initConfig(projectDir);
    } else {
      await runPicker(projectDir);
    }
  }

  const config = loadConfigOrExit(projectDir);
  if (opts.auto) {
    config.workflow.autoApproveSpec = true;
    config.workflow.autoApprovePlan = true;
  }
  if (opts.model) config.implementer.model = opts.model;
  if (opts.provider) config.implementer.provider = opts.provider as typeof config.implementer.provider;

  try {
    const caps = await detectCapabilities(config);
    if (caps.contextLength) {
      config.implementer.contextLength = caps.contextLength;
    }
  } catch {
    // provider not reachable, use config default
  }

  const isInteractive = process.stdout.isTTY && !process.env['CI'];
  const useFullscreen = opts.fullscreen !== false && isInteractive;

  return { projectDir, config, useFullscreen };
}
