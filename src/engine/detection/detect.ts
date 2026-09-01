import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  selectCliAuthChannel,
  type CliAuthChannelId,
  type CliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import { classifyCliAdmittedVersion } from '../../core/runners/cli-version.js';
import type { RunnerRole } from '../../core/runners/seat-roles.js';
import type { CliReadinessResult } from '../../core/schemas/readiness.js';
import { cliReadinessCheckId, deriveCliReadiness } from '../../core/schemas/readiness.js';
import { matches } from '../../utils/error.js';
import { throwIfAborted } from '../../utils/abort.js';
import { detectAvailableProviders } from '../providers/catalog-detection.js';
import type { ConfiguredProviderOutcome } from './provider-outcomes.js';
import {
  resolveCliExecutable,
  resolveCliExecutableAliases,
  type CliExecutableResolver,
} from '../runners/resolve-cli-executable.js';
import { lookupCliReadinessProbe } from '../runners/cli-tools/registry.js';
import { probeCliReadiness } from '../runners/cli-tools/readiness-probe.js';

type ResolveCliExecutable = CliExecutableResolver;
type ProbeCliReadiness = typeof probeCliReadiness;
type LookupCliReadinessProbe = typeof lookupCliReadinessProbe;

export interface DetectCliToolsOptions {
  projectDir?: string | undefined;
  /** Limit a live probe to the tools selected by a start configuration. */
  tools?: readonly CliToolId[] | undefined;
  role?: RunnerRole | undefined;
  /** Readiness-only resolver seam; this API cannot request native catalog work. */
  resolveExecutable?: ResolveCliExecutable | undefined;
  /** Readiness-only seam; native catalog work is not reachable through this API. */
  probeReadiness?: ProbeCliReadiness | undefined;
  /** Readiness-only declaration seam; native catalog work is not reachable through this API. */
  lookupProbe?: LookupCliReadinessProbe | undefined;
  authChannel?: CliAuthChannelId | undefined;
  authChannels?: Partial<Record<CliToolId, CliAuthChannelId | undefined>> | undefined;
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

export function cliDetectionFromReadiness(result: CliReadinessResult): CliToolDetection {
  const diagnostic =
    result.remediation === null
      ? { state: 'ready' as const, remediation: null }
      : { state: result.status, remediation: result.remediation };
  return {
    tool: result.tool,
    executable: result.executable,
    trust: result.trust,
    installedVersion: result.installedVersion,
    testedVersion: result.testedVersion,
    compatibility: result.compatibility,
    auth: result.auth,
    ...(result.providerAuth === undefined ? {} : { providerAuth: result.providerAuth }),
    diagnostic,
    probedAt: result.probedAt,
  };
}

type AuthChannelSelection =
  | Readonly<{ state: 'selected'; channel: CliAuthChannelId }>
  | Readonly<{ state: 'withheld' }>;

interface DetectCliToolDependencies {
  projectDir: string;
  resolveExecutable: ResolveCliExecutable;
  probeReadiness: ProbeCliReadiness;
  lookupProbe: LookupCliReadinessProbe;
  role: RunnerRole;
  authChannel: AuthChannelSelection;
  now: () => number;
  signal: AbortSignal | undefined;
}

function selectedAuthChannel(
  options: DetectCliToolsOptions,
  tool: CliToolId,
): AuthChannelSelection {
  if (options.authChannels && Object.hasOwn(options.authChannels, tool)) {
    const channel = options.authChannels[tool];
    return channel === undefined ? { state: 'withheld' } : { state: 'selected', channel };
  }
  if (options.authChannel !== undefined) {
    return { state: 'selected', channel: options.authChannel };
  }
  return { state: 'withheld' };
}

function unresolvedReadiness(
  tool: CliToolId,
  probedAt: number,
  untrusted: boolean,
): CliReadinessResult {
  const testedVersion = CLI_TOOL_CATALOG[tool].compatibility.testedVersion;
  if (untrusted) {
    // The resolver deliberately withholds the candidate path for an untrusted
    // executable. Preserve that distinction without fabricating an identity:
    // installation was observed, but no trusted executable can reach the gate.
    return {
      tool,
      enabled: true,
      installation: 'installed',
      executable: null,
      trust: 'untrusted',
      installedVersion: null,
      testedVersion,
      compatibility: 'not-checked',
      auth: 'not-checked',
      probedAt,
      checkId: cliReadinessCheckId(tool),
      status: 'untrusted',
      remediation: `Trust the exact ${tool} executable identity, then run runner readiness again.`,
    };
  }

  return deriveCliReadiness({
    tool,
    enabled: true,
    installation: 'unavailable',
    executable: null,
    trust: 'not-checked',
    installedVersion: null,
    testedVersion,
    compatibility: 'not-checked',
    auth: 'not-checked',
    probedAt,
  });
}

async function detectCliToolReadiness(
  tool: CliToolId,
  options: DetectCliToolDependencies,
): Promise<CliReadinessResult> {
  throwIfAborted(options.signal);
  const descriptor = CLI_TOOL_CATALOG[tool];
  let executable: Awaited<ReturnType<ResolveCliExecutable>>;
  try {
    executable = (
      await resolveCliExecutableAliases({
        commands: descriptor.executableAliases,
        projectDir: options.projectDir,
        resolveExecutable: options.resolveExecutable,
      })
    ).executable;
  } catch (cause) {
    const untrusted = matches('cli-executable-untrusted')(cause);
    const probedAt = options.now();
    return unresolvedReadiness(tool, probedAt, untrusted);
  }
  throwIfAborted(options.signal);

  try {
    const selectedChannel =
      options.authChannel.state === 'withheld'
        ? undefined
        : selectCliAuthChannel(tool, { channel: options.authChannel.channel });
    const result = await options.probeReadiness({
      tool,
      executable,
      probe: options.lookupProbe({ tool, role: options.role }),
      authChannel: selectedChannel?.id,
      now: options.now,
      signal: options.signal,
      classifyVersion: ({ installedVersion }) =>
        classifyCliAdmittedVersion({
          installedVersion,
          minimumAdmittedVersion: descriptor.compatibility.minimumAdmittedVersion,
          versionScheme: descriptor.compatibility.versionScheme,
        }),
    });
    return deriveCliReadiness({
      tool: result.tool,
      enabled: result.enabled,
      installation: result.installation,
      executable: result.executable,
      trust: result.trust,
      installedVersion: result.installedVersion,
      testedVersion: result.testedVersion,
      compatibility: result.compatibility,
      auth: selectedChannel === undefined ? 'unknown' : result.auth,
      ...(selectedChannel === undefined ? {} : { authChannel: selectedChannel.id }),
      ...(result.providerAuth === undefined ? {} : { providerAuth: result.providerAuth }),
      probedAt: result.probedAt,
    });
  } catch {
    throwIfAborted(options.signal);
    return deriveCliReadiness({
      tool,
      enabled: true,
      installation: 'installed',
      executable,
      trust: 'trusted',
      installedVersion: null,
      testedVersion: descriptor.compatibility.testedVersion,
      compatibility: 'unverified',
      auth: 'not-checked',
      probedAt: options.now(),
    });
  }
}

async function detectCliTool(
  tool: CliToolId,
  options: DetectCliToolDependencies,
): Promise<CliToolDetection> {
  return cliDetectionFromReadiness(await detectCliToolReadiness(tool, options));
}

/**
 * Run the canonical bounded CLI probes and retain their readiness facts for
 * the start gate. This deliberately bypasses the detection cache: a start
 * gate must be based on the executable identity and auth state observed for
 * this invocation, not a stale store snapshot.
 */
export async function detectAvailableCliReadiness(
  options: DetectCliToolsOptions = {},
): Promise<CliReadinessResult[]> {
  const dependencies = {
    projectDir: options.projectDir ?? process.cwd(),
    resolveExecutable: options.resolveExecutable ?? resolveCliExecutable,
    probeReadiness: options.probeReadiness ?? probeCliReadiness,
    lookupProbe: options.lookupProbe ?? lookupCliReadinessProbe,
    role: options.role ?? 'planner',
    now: options.now ?? Date.now,
    signal: options.signal,
  };
  const tools = options.tools ?? CLI_TOOL_IDS;
  return Promise.all(
    tools.map((tool) =>
      detectCliToolReadiness(tool, {
        ...dependencies,
        authChannel: selectedAuthChannel(options, tool),
      }),
    ),
  );
}

export async function detectAvailableCliTools(
  options: DetectCliToolsOptions = {},
): Promise<CliToolDetection[]> {
  const dependencies = {
    projectDir: options.projectDir ?? process.cwd(),
    resolveExecutable: options.resolveExecutable ?? resolveCliExecutable,
    probeReadiness: options.probeReadiness ?? probeCliReadiness,
    lookupProbe: options.lookupProbe ?? lookupCliReadinessProbe,
    role: options.role ?? 'planner',
    now: options.now ?? Date.now,
    signal: options.signal,
  };
  const tools = options.tools ?? CLI_TOOL_IDS;
  return Promise.all(
    tools.map((tool) =>
      detectCliTool(tool, {
        ...dependencies,
        authChannel: selectedAuthChannel(options, tool),
      }),
    ),
  );
}

export interface DetectAllResult {
  providers: ProviderDetection[];
  cliTools: CliToolDetection[];
  /** Present only for configuration-scoped API catalog discovery. */
  configuredProviderOutcomes?: readonly ConfiguredProviderOutcome[] | undefined;
}

export interface DetectAllOptions {
  detectProviders?:
    | ((input: Readonly<{ signal?: AbortSignal | undefined }>) => Promise<ProviderDetection[]>)
    | undefined;
  /**
   * Probes only API connections selected by the active runner configuration.
   * When supplied, this is authoritative and the broad legacy provider scan is
   * deliberately not constructed.
   */
  detectConfiguredProviderOutcomes?:
    | ((
        input: Readonly<{ signal?: AbortSignal | undefined }>,
      ) => Promise<readonly ConfiguredProviderOutcome[]>)
    | undefined;
  detectCliTools?: ((input: DetectCliToolsOptions) => Promise<CliToolDetection[]>) | undefined;
  authChannel?: CliAuthChannelId | undefined;
  authChannels?: Partial<Record<CliToolId, CliAuthChannelId | undefined>> | undefined;
  signal?: AbortSignal | undefined;
}

export async function detectAll(options: DetectAllOptions = {}): Promise<DetectAllResult> {
  throwIfAborted(options.signal);
  const configuredProviderOutcomes = options.detectConfiguredProviderOutcomes;
  const [providers, cliTools, configured] = await Promise.all([
    configuredProviderOutcomes === undefined
      ? (options.detectProviders ?? detectAvailableProviders)({ signal: options.signal })
      : Promise.resolve([]),
    (options.detectCliTools ?? detectAvailableCliTools)({
      authChannel: options.authChannel,
      authChannels: options.authChannels,
      signal: options.signal,
    }),
    configuredProviderOutcomes === undefined
      ? Promise.resolve(undefined)
      : configuredProviderOutcomes({ signal: options.signal }),
  ]);
  throwIfAborted(options.signal);
  return {
    providers,
    cliTools,
    ...(configured === undefined ? {} : { configuredProviderOutcomes: configured }),
  };
}
