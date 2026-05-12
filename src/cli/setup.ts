import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, initConfig, configPath } from '../core/config/load/load.js';
import { isGitRepo } from '../lib/git.js';
import { DIPTYCH_DIR, CONFIG_FILE } from '../core/paths.js';
import { cliError } from './errors.js';
import { toErrorMessage } from '../utils/format-errors.js';
import type { WorkflowOpts } from '../core/types/config-options.js';

const NO_CONFIG_MSG = `No config found. Creating default ${DIPTYCH_DIR}/${CONFIG_FILE}`;

export function resolveProjectDir(dir?: string): string {
  return resolve(dir ?? process.cwd());
}

export function loadConfigOrExit(projectDir: string): ReturnType<typeof loadConfig> {
  try {
    return loadConfig(projectDir);
  } catch (err) {
    throw cliError(toErrorMessage(err), 1);
  }
}

async function assertGitRepo(projectDir: string): Promise<void> {
  if (!(await isGitRepo(projectDir))) {
    throw cliError('not a git repository. Run `git init` first.', 1);
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
  useMouse: boolean;
  needsSetup?: boolean | undefined;
}

export async function setupWorkflow(opts: WorkflowOpts): Promise<SetupResult> {
  const projectDir = resolveProjectDir(opts.project);

  await assertGitRepo(projectDir);

  const isInteractive = process.stdout.isTTY && !process.env['CI'];
  const useFullscreen = opts.fullscreen !== false && isInteractive;
  const useMouse = opts.mouse !== false && useFullscreen;

  const hasOverrides =
    opts.model !== undefined ||
    opts.provider !== undefined ||
    opts.planner !== undefined ||
    opts.plannerModel !== undefined ||
    opts.plannerCommand !== undefined ||
    opts.implementer !== undefined ||
    opts.implementerModel !== undefined ||
    opts.implementerCommand !== undefined;
  if (!existsSync(configPath(projectDir))) {
    if (hasOverrides) {
      console.log(NO_CONFIG_MSG);
      initConfig(projectDir);
    } else {
      initConfig(projectDir);
      return { projectDir, useFullscreen, useMouse, needsSetup: true };
    }
  }

  return { projectDir, useFullscreen, useMouse };
}
