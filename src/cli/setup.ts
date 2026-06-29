import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, initConfig, configPath } from '../core/config/load/io.js';
import { isGitRepo, getRepoToplevel } from '../lib/git.js';
import { DIPTYCH_DIR, CONFIG_FILE } from '../core/paths.js';
import { cliError } from './errors.js';
import { toErrorMessage } from '../utils/format-errors.js';
import { stripTerminalControls } from '../utils/display-text.js';
import type { WorkflowOpts } from '../core/types/config-options.js';

const NO_CONFIG_MSG = `No config found. Creating default ${DIPTYCH_DIR}/${CONFIG_FILE}`;

export function resolveProjectDir(dir?: string): string {
  return resolve(dir ?? process.cwd());
}

export async function canonicalizeProjectDir(opts: {
  project?: string | undefined;
}): Promise<string> {
  const resolved = resolveProjectDir(opts.project);
  const toplevel = await getRepoToplevel(resolved);
  if (toplevel === null) return resolved;

  // getRepoToplevel returns a realpath-canonicalized path (git resolves
  // symlinks); resolve() does not, so canonicalize before comparing or a
  // symlinked path component (e.g. macOS /tmp -> /private/tmp) makes an exact
  // repo-root invocation look like a subdirectory.
  const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
  if (toplevel === canonical) return toplevel;

  if (opts.project !== undefined) {
    console.error(
      `Warning: --project ${stripTerminalControls(resolved)} is inside git repository ${stripTerminalControls(toplevel)}; using repository root.`,
    );
  }
  return toplevel;
}

export function isInteractiveTty(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env['CI'];
}

export function assertInteractiveTty(): void {
  if (!process.stdin.isTTY) {
    throw cliError('interactive mode needs a TTY — use --json or --detach', 1);
  }
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
    console.error(NO_CONFIG_MSG);
    initConfig(projectDir);
  }
}

export interface SetupResult {
  projectDir: string;
  useFullscreen: boolean;
  useMouse: boolean;
  useHover: boolean;
  needsSetup?: boolean | undefined;
}

export async function setupWorkflow(opts: WorkflowOpts): Promise<SetupResult> {
  const projectDir = await canonicalizeProjectDir(opts);

  await assertGitRepo(projectDir);

  const isInteractive = isInteractiveTty();
  const useFullscreen = opts.fullscreen !== false && isInteractive;
  const useMouse = opts.mouse !== false && useFullscreen;
  const useHover = opts.hover === true && useMouse;

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
      return { projectDir, useFullscreen, useMouse, useHover, needsSetup: true };
    }
  }

  return { projectDir, useFullscreen, useMouse, useHover };
}
