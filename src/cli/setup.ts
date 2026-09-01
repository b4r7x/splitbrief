import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, initConfig } from '../core/config/load/io.js';
import { configPath } from '../core/config/load/document.js';
import { isGitRepo, getRepoToplevel } from '../lib/git/repository.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../core/paths.js';
import { cliError } from './errors.js';
import { toErrorMessage } from '../utils/format-errors.js';
import { stripTerminalControls } from '../utils/display-text.js';
import type { WorkflowOpts } from '../core/types/config-options.js';

const NO_CONFIG_MSG = `No config found. Creating default ${SPLITBRIEF_DIR}/${CONFIG_FILE}`;

function resolveProjectDir(dir?: string): string {
  return resolve(dir ?? process.cwd());
}

/**
 * Every command resolves its project through here, so a session started from
 * `packages/web` is the same session `ps`, `status` and `doctor` see from the
 * repository root, and `spec` never auto-creates a second config next to a
 * nested package.json.
 */
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

// The remedy is the caller's, not this helper's: `start` has `--json` and
// `--detach`, `init` has `--yes`. Naming a flag the command does not define is
// the failure this parameter exists to prevent.
export function assertInteractiveTty(remedy: string): void {
  if (!process.stdin.isTTY) {
    throw cliError(`interactive mode needs a TTY — ${remedy}`, 1);
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
    await initConfig(projectDir);
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
      await initConfig(projectDir);
    } else {
      return { projectDir, useFullscreen, useMouse, useHover, needsSetup: true };
    }
  }

  return { projectDir, useFullscreen, useMouse, useHover };
}
