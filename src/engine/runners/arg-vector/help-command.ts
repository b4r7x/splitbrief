import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliExecutableIdentity } from '../../../core/discovery/detection/executable.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { spawnWithTimeout } from '../../../lib/process/spawn/progress.js';
import { CLI_PROBE_TIMEOUT_MS } from '../../constants.js';
import { trackProbe } from '../../probe-activity.js';
import { resolveCliExecutableAliases } from '../cli-executable/resolve.js';
import { probeEnvironment } from '../cli-tools/probe/process.js';
import { removeSandboxTempDirs } from '../sandbox/state/paths.js';
import { subcommandCandidate } from './help-text.js';

/**
 * The help run is a real execution of a real binary, so it takes the same
 * identity the run itself would take: an absolute path the executable-trust
 * ladder admitted, never a bare name the OS resolves against the inherited
 * PATH. A refused or absent candidate yields no help text, which the caller
 * already reports as `ok`.
 */
async function resolveHelpExecutable(
  tool: CliToolId,
  projectDir: string,
): Promise<CliExecutableIdentity | null> {
  try {
    const resolved = await resolveCliExecutableAliases({
      commands: CLI_TOOL_CATALOG[tool].executableAliases,
      projectDir,
    });
    return resolved.executable;
  } catch {
    return null;
  }
}

/**
 * The comparison text is every help the binary itself prints for this argv:
 * the top-level help plus the subcommand's, joined. A single argv legitimately
 * mixes both scopes — Codex 0.147 takes `--sandbox` and `--ask-for-approval`
 * only before `exec`, and `--json` only after it — so scoring one help against
 * the other and keeping the winner reported the loser's flags as unsupported
 * and blocked a run the binary accepts.
 */
export function defaultRunHelp(projectDir: string, signal: AbortSignal | undefined) {
  const helpTexts = new Map<string, Promise<string | null>>();
  const helpFor = (tool: CliToolId, subcommand?: string): Promise<string | null> => {
    const key = subcommand === undefined ? tool : `${tool} ${subcommand}`;
    const cached = helpTexts.get(key);
    if (cached !== undefined) return cached;
    const pending = fetchHelp(tool, projectDir, subcommand, signal);
    helpTexts.set(key, pending);
    return pending;
  };
  return async (tool: CliToolId, argv: readonly string[]): Promise<string | null> => {
    const topLevel = await helpFor(tool);
    if (topLevel === null) return null;
    const subcommand = subcommandCandidate({
      argv,
      topLevelHelp: topLevel,
      command: CLI_TOOL_CATALOG[tool].command,
    });
    if (subcommand === null) return topLevel;
    const subcommandHelp = await helpFor(tool, subcommand);
    if (subcommandHelp === null) return topLevel;
    return `${topLevel}\n${subcommandHelp}`;
  };
}

async function fetchHelp(
  tool: CliToolId,
  projectDir: string,
  subcommand: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const executable = await resolveHelpExecutable(tool, projectDir);
  if (executable === null) return null;
  // The help probe runs in a disposable stage with the version probe's sandbox HOME, never in the
  // project or the user's HOME: the read-only working directory cannot observe or write project
  // state, and a tool that installs a pending update when it starts finds no record of one.
  const stageDir = await mkdtemp(join(tmpdir(), 'splitbrief-help-'));
  try {
    const { env } = await probeEnvironment({
      executable,
      neutralDir: stageDir,
      tool,
      channel: undefined,
    });
    const cwd = join(stageDir, 'cwd');
    await mkdir(cwd, { mode: 0o500 });
    return await trackProbe({ tool, check: 'options' }, () =>
      runHelpCommand({ executablePath: executable.path, env, cwd, subcommand, signal }),
    );
  } finally {
    await rm(stageDir, { recursive: true, force: true });
    removeSandboxTempDirs(stageDir);
  }
}

async function runHelpCommand({
  executablePath,
  env,
  cwd,
  subcommand,
  signal,
}: Readonly<{
  executablePath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  subcommand: string | undefined;
  signal: AbortSignal | undefined;
}>): Promise<string | null> {
  const args = subcommand === undefined ? ['--help'] : [subcommand, '--help'];
  try {
    const result = await spawnWithTimeout({
      command: executablePath,
      args,
      cwd,
      env,
      timeout: CLI_PROBE_TIMEOUT_MS,
      signal,
      onProgress: () => undefined,
    });
    if (result.timedOut) return null;
    return `${result.output}\n${result.stderr}`.trim();
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return null;
  }
}
