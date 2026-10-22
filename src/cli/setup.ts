import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, initConfig } from '../core/config/load/io.js';
import { configPath, IGNORE_RULE_ADDED, readConfigDocument } from '../core/config/load/document.js';
import { selectInitialCrew } from '../core/crew/default.js';
import type { CLIOverrides } from '../core/config/runtime/overrides/schema.js';
import type { Config } from '../core/schemas/config.js';
import { CLI_TOOL_IDS, defaultCliAuthChannel } from '../core/runners/cli-tool-catalog.js';
import { detectAll, detectAvailableCliTools } from '../engine/detection/detect.js';
import { checkCrewAvailability, selectDetectedDefaultCrew } from '../engine/detection/crew.js';
import { readConfiguredCliRoutes } from './commands/start/readiness.js';
import { isGitRepo, getRepoToplevel } from '../lib/git/repository.js';
import { reapOrphanRunners } from '../engine/orchestrator/run/orphan-reaper.js';
import { cliError } from './errors.js';
import { toErrorMessage } from '../utils/format-errors.js';
import { warnStderr } from '../lib/warn.js';
import type { WorkflowOpts } from '../core/types/config-options.js';

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
    warnStderr(
      `Warning: --project ${resolved} is inside git repository ${toplevel}; using repository root.`,
    );
  }
  return toplevel;
}

export function isInteractiveTty(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env['CI'];
}

// The remedy is the caller's, not this helper's: `start` has `--json`, `init`
// has `--yes`. Naming a flag the command does not define is the failure this
// parameter exists to prevent.
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

export async function assertGitRepo(projectDir: string): Promise<void> {
  if (!(await isGitRepo(projectDir))) {
    throw cliError('not a git repository. Run `git init` first.', 1);
  }
}

export async function ensureHeadlessConfig(input: {
  projectDir: string;
  overrides?: CLIOverrides | undefined;
  reconfigure?: boolean | undefined;
}): Promise<Config | undefined> {
  const { projectDir, overrides = {} } = input;
  const snapshot = readConfigDocument(projectDir);
  if (snapshot.revision !== null && !input.reconfigure) return undefined;

  const detection = await detectAll({
    detectCliTools: (options) => detectAvailableCliTools({ ...options, projectDir }),
    authChannels: Object.fromEntries(
      CLI_TOOL_IDS.map((tool) => [tool, defaultCliAuthChannel(tool).id]),
    ),
  });
  const detected = selectDetectedDefaultCrew(detection);
  const { persisted, effective } = selectInitialCrew({ detected, overrides });
  // A tool that stores no credential is ready on a route its model list serves, read as start reads it.
  const { catalogs } = await readConfiguredCliRoutes({
    projectDir,
    config: effective,
    cliReadiness: detection.cliTools.map(({ tool, diagnostic, providerAuth }) => ({
      tool,
      status: diagnostic.state,
      providerAuth,
    })),
    routeCatalogs: new Map(),
  });
  const [unavailable] = await checkCrewAvailability({
    config: effective,
    detection: {
      ...detection,
      cliCatalog: (tool) => catalogs.find((catalog) => catalog.tool === tool),
    },
  });
  if (unavailable !== undefined) {
    throw cliError(
      detected === null
        ? `${snapshot.revision === null ? 'No config found and no' : 'No'} ready crew is available. Run splitbrief init to choose and sign in to your tools.`
        : `${unavailable.label} is unavailable. Choose a ready tool and model, then retry. Run splitbrief init to check your tools.`,
      1,
    );
  }
  const saved = await initConfig(projectDir, persisted, {
    force: input.reconfigure === true,
    expectedRevision: snapshot.revision,
  });
  if (saved.kind !== 'saved') {
    throw cliError(
      saved.kind === 'conflict'
        ? 'Config changed during setup. Retry the command.'
        : 'Could not finish saving the crew. Retry the command.',
      1,
    );
  }
  console.error(
    snapshot.revision === null
      ? 'No config found. Saved a ready crew to .splitbrief/config.yaml.'
      : 'Saved a ready crew to .splitbrief/config.yaml.',
  );
  if (saved.ignoreRuleAdded) console.error(`${IGNORE_RULE_ADDED}.`);
  return effective;
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
  await reapOrphanRunners(projectDir);

  const isInteractive = isInteractiveTty();
  const useFullscreen = opts.fullscreen !== false && isInteractive;
  const useMouse = opts.mouse !== false && useFullscreen;
  const useHover = opts.hover === true && useMouse;

  if (!existsSync(configPath(projectDir))) {
    return { projectDir, useFullscreen, useMouse, useHover, needsSetup: true };
  }

  return { projectDir, useFullscreen, useMouse, useHover };
}
