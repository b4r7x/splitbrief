import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliExecutableIdentity } from '../../../core/discovery/detection/executable.js';
import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import type { ProbeOutcome } from '../../../core/discovery/runner-evidence.js';
import { cliAuthChannelPlatformSupported } from '../../../core/runners/cli-tool/auth-channels.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-tool/version.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text/diagnostic.js';
import { stripTerminalControls } from '../../../utils/display-text/sanitize.js';
import { isENOENT } from '../../../utils/errno.js';
import { trackProbe } from '../../probe-activity.js';
import { resolveCustomExecutable } from '../../runners/cli-executable/custom.js';
import type {
  CliCatalogProbe,
  CliProbeOutput,
  CliDeclaredProbeContract,
} from '../../runners/cli-tools/probe/contract.js';
import { parseCompleteCommandCodeNativeModelCatalog } from '../../runners/cli-tools/probe/native-catalog/command-code.js';
import { nativeCliCatalogToDetectedModels } from '../../runners/cli-tools/probe/native-catalog/entries.js';
import {
  type ProbeOutputBudget,
  probeRuntimePath,
  spawnProbe,
} from '../../runners/cli-tools/probe/process.js';
import { providerOracleCommand } from '../../runners/cli-tools/probe/provider-oracle.js';
import { probeCommandsMatch } from '../../runners/cli-tools/probe/safety.js';
import { withProbeStage } from '../../runners/cli-tools/probe/stage.js';
import type { AuthProbeRun } from '../../runners/cli-tools/probe/declared-readiness.js';
import { cliChannelStaging } from '../../runners/sandbox/auth-env.js';
import { createSandboxEnv, prependCliExecutableDirectory } from '../../runners/sandbox/env.js';
import { bridgedCliStatePresent } from '../../runners/sandbox/state/bridge.js';
import type { CliRunnerDiscoveryContext } from '../cli-context.js';
import {
  type AdmittedCatalogOperation,
  admitCatalogOperation,
  catalogOperationIsFresh,
  selectedCatalogProbe,
  catalogProbeForVersion,
} from './admission.js';

const CATALOG_PROBE_OUTPUT: ProbeOutputBudget = {
  ceilingBytes: 4 * 1024 * 1024,
  policy: 'prefix-tail',
};
/**
 * Command Code prints its listing in half a second, then flushes telemetry for
 * five to ten more before it exits, so every probe outlived its budget. Its own
 * `isTelemetryEnabled` honours `DO_NOT_TRACK`, and with it the process exits
 * with the listing.
 */
const CATALOG_PROBE_ENV: Readonly<Partial<Record<CliToolId, Readonly<Record<string, string>>>>> =
  Object.freeze({ 'command-code': Object.freeze({ DO_NOT_TRACK: '1' }) });

type CatalogProbeEnvironment = Readonly<{
  env: NodeJS.ProcessEnv;
  /**
   * False only when the staged environment can see that the credential is not
   * there. An OS keychain item is invisible from the environment either way, so
   * it stays true and the probe itself decides.
   */
  credentialMayBePresent: boolean;
}>;

async function catalogProbeEnvironment(
  operation: AdmittedCatalogOperation,
  neutralDir: string,
): Promise<CatalogProbeEnvironment> {
  const { selectedCli, hostState, preserveEnvKeys } = cliChannelStaging(
    operation.context.id,
    operation.authChannel,
  );
  const env = await createSandboxEnv({
    projectDir: neutralDir,
    preserveEnvKeys,
    selectedCli,
    hostState,
  });
  const credentialMayBePresent =
    hostState === 'host-account' ||
    preserveEnvKeys.some((key) => (env[key] ?? '').trim().length > 0) ||
    (hostState === 'bridged-files' && (await bridgedCliStatePresent(env, operation.context.id)));
  return {
    env: {
      ...env,
      ...CATALOG_PROBE_ENV[operation.context.id],
      PATH: prependCliExecutableDirectory({
        executablePath: operation.executable.path,
        safeRuntimePath: probeRuntimePath(),
      }),
    },
    credentialMayBePresent,
  };
}

async function runAdmittedCatalogProbe(
  operation: AdmittedCatalogOperation,
  command: Exclude<CliCatalogProbe, { kind: 'not-run' }>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  projectDir: string | undefined,
): Promise<ProbeOutcome<readonly DetectedModel[]>> {
  const [, ...declared] = command.command;
  // The cwd stays neutral; only the header names the project, encoded as
  // OpenCode's own client encodes it, so no path segment becomes an argument.
  const args =
    projectDir === undefined || command.directoryHeader === undefined
      ? declared
      : [...declared, '-H', `${command.directoryHeader}:${encodeURIComponent(projectDir)}`];
  const { output, spawnFailure } = await spawnProbe({
    executablePath: operation.executable.path,
    args,
    cwd,
    env,
    signal,
    maxOutputBytes: command.maxOutputBytes,
    budget: CATALOG_PROBE_OUTPUT,
  });
  const homeFiles = await readProbeHomeFiles(command, env.HOME);
  return catalogOutcomeFromProbe(
    operation.context.id,
    command,
    { ...output, homeFiles },
    spawnFailure,
  );
}

/**
 * The `.json` files the listing wrote under the HOME the probe staged for it. The
 * staging is deleted after the probe, so they are read here. A missing folder is a
 * listing that wrote none, and a file over the probe's byte limit is skipped.
 */
async function readProbeHomeFiles(
  command: Exclude<CliCatalogProbe, { kind: 'not-run' }>,
  home: string | undefined,
): Promise<readonly string[]> {
  if (command.homeFilesDirectory === undefined || home === undefined) return [];
  const directory = join(home, ...command.homeFilesDirectory);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  const texts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(directory, entry.name);
    if ((await stat(path)).size > command.maxOutputBytes) continue;
    texts.push(await readFile(path, 'utf8'));
  }
  return texts;
}

function catalogCommandFailureCause(
  output: CliProbeOutput,
  spawnFailure: Error | undefined,
): string {
  const lines = output.stderr
    .split(/[\r\n]/)
    .map((line) => stripTerminalControls(line).trim())
    .filter((line) => line !== '');
  // A tool may print progress before its error (`agy models` writes `Fetching available
  // models...` first), so the line the tool labels as its error outranks the first line.
  const line = lines.find((candidate) => /^error:/i.test(candidate)) ?? lines[0] ?? '';
  const cause = sanitizeTerminalDiagnosticText(line.replace(/^error:\s*/i, ''), {
    maxChars: 200,
  }).trim();
  if (cause !== '') return cause;
  if (spawnFailure !== undefined) {
    return sanitizeTerminalDiagnosticText(spawnFailure.message, { maxChars: 200 }).trim();
  }
  return output.exitCode === null ? 'no exit code' : `exit code ${output.exitCode}`;
}

function catalogOutcomeFromProbe(
  tool: CliToolId,
  probe: Exclude<CliCatalogProbe, { kind: 'not-run' }>,
  output: CliProbeOutput,
  spawnFailure: Error | undefined,
): ProbeOutcome<readonly DetectedModel[]> {
  if (output.outputExceeded) return { kind: 'malformed' };
  if (output.timedOut) {
    // spawnPipe has already reaped the process group. Only this native listing
    // has a declared row count and terminal footer; an ordinary parse is not
    // evidence that timeout output contains the entire catalog.
    const complete =
      tool === 'command-code' && output.stderr.trim() === ''
        ? parseCompleteCommandCodeNativeModelCatalog(output.stdout, output.homeFiles)
        : null;
    return complete === null
      ? { kind: 'timeout' }
      : { kind: 'success', value: nativeCliCatalogToDetectedModels(complete) };
  }
  if (output.exitCode !== 0) {
    return { kind: 'command-failed', cause: catalogCommandFailureCause(output, spawnFailure) };
  }
  try {
    return probe.parse(output);
  } catch {
    return { kind: 'malformed' };
  }
}

export async function probeContextCatalog(
  input: Readonly<{
    context: CliRunnerDiscoveryContext;
    executable: CliExecutableIdentity;
    probe: CliDeclaredProbeContract;
    version: ProbeOutcome<string>;
    refresh: 'automatic' | 'manual';
    projectDir: string;
    /** The listing names `projectDir` to a tool that declares a directory header. */
    namesProject: boolean;
    now: () => number;
    signal: AbortSignal | undefined;
    /** This pass's auth status run. When its argv is the catalog's, its output is the listing. */
    authProbeRun?: AuthProbeRun | undefined;
  }>,
): Promise<ProbeOutcome<readonly DetectedModel[]>> {
  throwIfAborted(input.signal);
  const operation = admitCatalogOperation({
    context: input.context,
    executable: input.executable,
    probe: input.probe,
    version: input.version,
    refresh: input.refresh,
    issuedAt: input.now(),
  });
  if (operation === undefined) return { kind: 'unsupported' };
  if (!cliAuthChannelPlatformSupported(operation.authChannel)) return { kind: 'unsupported' };
  if (
    !catalogOperationIsFresh(operation, input.now()) ||
    classifyCliAdmittedVersion({
      installedVersion: operation.installedVersion,
      minimumAdmittedVersion:
        CLI_TOOL_CATALOG[operation.context.id].compatibility.minimumAdmittedVersion,
      versionScheme: CLI_TOOL_CATALOG[operation.context.id].compatibility.versionScheme,
    }) !== 'compatible'
  ) {
    return { kind: 'unsupported' };
  }
  const probe = selectedCatalogProbe(
    catalogProbeForVersion(operation.context.id, operation.probe, operation.installedVersion),
    operation.refresh,
  );
  // Immediately before dispatch, re-read the runtime receipt from disk
  // (content digest included): the admitted identity/cache namespace must
  // still match the executable that will run, so a fake loader, a replaced
  // binary, or a different cache namespace fails closed with zero dispatch.
  const reRead = await resolveCustomExecutable({
    command: operation.executable.executableIdentity.canonicalPath,
    projectDir: input.projectDir,
    expected: operation.executable,
  });
  if (reRead.kind !== 'resolved') return { kind: 'cancelled' };
  return withProbeStage('splitbrief-catalog-', input.signal, async (neutralDir, signal) => {
    const environment = await catalogProbeEnvironment(operation, neutralDir);
    throwIfAborted(signal);
    // A provider-dependent tool reaches some providers with no credential (a
    // project's own provider, the keyless `opencode` one), so its staged
    // listing runs and names exactly the providers a run can reach.
    if (
      providerOracleCommand(operation.context.id) === undefined &&
      !environment.credentialMayBePresent
    ) {
      return { kind: 'missing-credential' };
    }
    const outcome =
      input.authProbeRun !== undefined &&
      probeCommandsMatch({ left: probe, right: input.authProbeRun.command })
        ? catalogOutcomeFromProbe(operation.context.id, probe, input.authProbeRun.output, undefined)
        : await trackProbe({ tool: operation.context.id, check: 'model list' }, () =>
            runAdmittedCatalogProbe(
              operation,
              probe,
              neutralDir,
              environment.env,
              signal,
              input.namesProject ? input.projectDir : undefined,
            ),
          );
    const after = await resolveCustomExecutable({
      command: operation.executable.executableIdentity.canonicalPath,
      projectDir: input.projectDir,
      expected: operation.executable,
    });
    return after.kind === 'resolved' ? outcome : { kind: 'cancelled' };
  });
}
