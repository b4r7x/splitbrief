import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  defaultCliAuthChannel,
  selectCliAuthChannel,
  type CliAuthChannelId,
  type CliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import type { CliReadinessResult } from '../../core/schemas/readiness.js';
import { cliReadinessCheckId, deriveCliReadiness } from '../../core/schemas/readiness.js';
import { matches } from '../../utils/error.js';
import { warnError } from '../../lib/warn.js';
import { DETECTION_TIMEOUT_MS } from '../constants.js';
import { parseMajorVersion } from '../availability.js';
import { detectAvailableProviders } from '../providers/registry.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import {
  authChannelRequiresCredential,
  probeCliReadiness,
} from '../runners/cli-tools/readiness-probe.js';

const CLI_PROBE_OUTPUT_MAX_BYTES = 64 * 1024;

type ResolveCliExecutable = typeof resolveCliExecutable;
type ProbeCliReadiness = typeof probeCliReadiness;

export interface DetectCliToolsOptions {
  projectDir?: string | undefined;
  /** Limit a live probe to the tools selected by a start configuration. */
  tools?: readonly CliToolId[] | undefined;
  resolveExecutable?: ResolveCliExecutable | undefined;
  probeReadiness?: ProbeCliReadiness | undefined;
  authChannel?: CliAuthChannelId | undefined;
  authChannels?: Partial<Record<CliToolId, CliAuthChannelId | undefined>> | undefined;
  now?: (() => number) | undefined;
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
    diagnostic,
    probedAt: result.probedAt,
  };
}

/**
 * A caller that names no channel for a tool gets the channel that tool's runner
 * takes when its configuration names none, so readiness measures the channel
 * execution will actually stage. A caller that names the tool but withholds its
 * channel — conflicting roles — keeps the probe channel-less so readiness
 * cannot claim authentication for a channel nobody selected.
 */
type AuthChannelSelection =
  | Readonly<{ state: 'selected'; channel: CliAuthChannelId }>
  | Readonly<{ state: 'withheld' }>;

interface DetectCliToolDependencies {
  projectDir: string;
  resolveExecutable: ResolveCliExecutable;
  probeReadiness: ProbeCliReadiness;
  authChannel: AuthChannelSelection;
  now: () => number;
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
  return { state: 'selected', channel: defaultCliAuthChannel(tool).id };
}

function classifyVersion(input: {
  installedVersion: string;
  testedVersion: string;
}): 'compatible' | 'incompatible' | 'unverified' {
  const installedMajor = parseMajorVersion(input.installedVersion);
  const testedMajor = parseMajorVersion(input.testedVersion);
  if (installedMajor === null || testedMajor === null) return 'unverified';
  return installedMajor === testedMajor ? 'compatible' : 'incompatible';
}

function unresolvedDetection(
  tool: CliToolId,
  probedAt: number,
  untrusted: boolean,
): CliToolDetection {
  const testedVersion = CLI_TOOL_CATALOG[tool].compatibility.testedVersion;
  if (untrusted) {
    return {
      tool,
      executable: null,
      trust: 'untrusted',
      installedVersion: null,
      testedVersion,
      compatibility: 'not-checked',
      auth: 'not-checked',
      diagnostic: {
        state: 'untrusted',
        remediation: `Trust the exact ${tool} executable identity, then run runner readiness again.`,
      },
      probedAt,
    };
  }

  return cliDetectionFromReadiness(
    deriveCliReadiness({
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
    }),
  );
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

type CliReadinessProbeOutcome = Readonly<{
  readiness: CliReadinessResult;
  executableResolution: 'unavailable' | 'untrusted' | 'resolved';
}>;

async function detectCliToolReadiness(
  tool: CliToolId,
  options: DetectCliToolDependencies,
): Promise<CliReadinessProbeOutcome> {
  const descriptor = CLI_TOOL_CATALOG[tool];
  let executable: Awaited<ReturnType<ResolveCliExecutable>>;
  try {
    executable = await options.resolveExecutable(descriptor.command, options.projectDir);
  } catch (cause) {
    const untrusted = matches('cli-executable-untrusted')(cause);
    const probedAt = options.now();
    return {
      executableResolution: untrusted ? 'untrusted' : 'unavailable',
      readiness: unresolvedReadiness(tool, probedAt, untrusted),
    };
  }

  try {
    const versionProbe = {
      command: [descriptor.command, '--version'] as const,
      cwd: 'neutral' as const,
      timeoutMs: DETECTION_TIMEOUT_MS,
      maxOutputBytes: CLI_PROBE_OUTPUT_MAX_BYTES,
    };
    const selectedChannel =
      options.authChannel.state === 'withheld'
        ? undefined
        : selectCliAuthChannel(tool, { channel: options.authChannel.channel });
    // The probe only reaches the auth classifier once the selected channel's
    // credential material is present in the staged environment and the tool ran
    // under it, so a zero-exit auth probe is the strongest authentication fact a
    // bounded, non-billable readiness command can produce.
    const requiresCredential =
      selectedChannel !== undefined && authChannelRequiresCredential(selectedChannel);
    const result = await options.probeReadiness({
      tool,
      executable,
      probe: {
        version: versionProbe,
        auth: versionProbe,
      },
      authChannel: selectedChannel?.id,
      now: options.now,
      classifyVersion,
      classifyAuth: () => (requiresCredential ? 'authenticated' : 'not-required'),
    });
    return {
      executableResolution: 'resolved',
      readiness: deriveCliReadiness({
        tool: result.tool,
        enabled: result.enabled,
        installation: result.installation,
        executable: result.executable,
        trust: result.trust,
        installedVersion: result.installedVersion,
        testedVersion: result.testedVersion,
        compatibility: result.compatibility,
        auth: selectedChannel === undefined ? 'unknown' : result.auth,
        probedAt: result.probedAt,
      }),
    };
  } catch (cause) {
    warnError(`CLI readiness probe (${tool})`, cause);
    return {
      executableResolution: 'resolved',
      readiness: deriveCliReadiness({
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
      }),
    };
  }
}

async function detectCliTool(
  tool: CliToolId,
  options: DetectCliToolDependencies,
): Promise<CliToolDetection> {
  const outcome = await detectCliToolReadiness(tool, options);
  if (outcome.executableResolution === 'untrusted') {
    return unresolvedDetection(tool, outcome.readiness.probedAt, true);
  }
  return cliDetectionFromReadiness(outcome.readiness);
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
    now: options.now ?? Date.now,
  };
  const tools = options.tools ?? CLI_TOOL_IDS;
  return Promise.all(
    tools.map(async (tool) => {
      const outcome = await detectCliToolReadiness(tool, {
        ...dependencies,
        authChannel: selectedAuthChannel(options, tool),
      });
      return outcome.readiness;
    }),
  );
}

export async function detectAvailableCliTools(
  options: DetectCliToolsOptions = {},
): Promise<CliToolDetection[]> {
  const dependencies = {
    projectDir: options.projectDir ?? process.cwd(),
    resolveExecutable: options.resolveExecutable ?? resolveCliExecutable,
    probeReadiness: options.probeReadiness ?? probeCliReadiness,
    now: options.now ?? Date.now,
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
}

interface DetectAllOptions {
  detectProviders?: (() => Promise<ProviderDetection[]>) | undefined;
  detectCliTools?: (() => Promise<CliToolDetection[]>) | undefined;
  authChannel?: CliAuthChannelId | undefined;
  authChannels?: Partial<Record<CliToolId, CliAuthChannelId | undefined>> | undefined;
}

export async function detectAll(options: DetectAllOptions = {}): Promise<DetectAllResult> {
  const [providers, cliTools] = await Promise.all([
    (options.detectProviders ?? detectAvailableProviders)(),
    (
      options.detectCliTools ??
      (() =>
        detectAvailableCliTools({
          authChannel: options.authChannel,
          authChannels: options.authChannels,
        }))
    )(),
  ]);
  return { providers, cliTools };
}
