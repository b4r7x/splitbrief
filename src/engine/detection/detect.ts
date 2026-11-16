import type { CliExecutableIdentity } from '../../core/discovery/detection/executable.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection/tool.js';
import {
  CLI_TOOL_CATALOG,
  LISTED_CLI_TOOL_IDS,
  PROVIDER_ORACLE_TOOL_IDS,
} from '../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../core/runners/cli-tool/types.js';
import { classifyCliAdmittedVersion } from '../../core/runners/cli-tool/version.js';
import type { CliReadinessResult } from '../../core/schemas/readiness.js';
import { cliReadinessCheckId } from '../../core/schemas/readiness.js';
import {
  cliExecutableTrustRemediation,
  cliReadinessRemediation,
  deriveCliReadiness,
} from '../../core/readiness/cli-remediation.js';
import { matches } from '../../utils/error.js';
import { includes } from '../../utils/type-guards.js';
import { throwIfAborted } from '../../utils/abort.js';
import { detectAvailableProviders } from '../providers/catalog-detection.js';
import type { ConfiguredProviderOutcome } from './provider-outcomes.js';
import { resolveCliExecutableAliases } from '../runners/cli-executable/resolve.js';
import { lookupCliReadinessProbe } from '../runners/cli-tools/registry.js';
import { probeCliReadiness } from '../runners/cli-tools/probe/readiness.js';
import { trackToolCheck } from '../probe-activity.js';
import { readHostModelSelection } from '../runners/host-model-selection.js';

export interface DetectCliToolsOptions {
  projectDir?: string | undefined;
  /** Limit a live probe to the tools selected by a start configuration. */
  tools?: readonly CliToolId[] | undefined;
  signal?: AbortSignal | undefined;
}

/** A detection is what the runner picker shows, so its remediation ends on the picker's recheck. */
export function cliDetectionFromReadiness(result: CliReadinessResult): CliToolDetection {
  const diagnostic =
    result.status === 'ready'
      ? { state: 'ready' as const, remediation: null }
      : {
          state: result.status,
          remediation: cliReadinessRemediation(result, result.status, 'picker'),
        };
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

interface DetectCliToolDependencies {
  projectDir: string;
  signal: AbortSignal | undefined;
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
      remediation: cliExecutableTrustRemediation(CLI_TOOL_CATALOG[tool].displayName, 'doctor'),
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
  let executable: CliExecutableIdentity;
  try {
    executable = (
      await resolveCliExecutableAliases({
        commands: descriptor.executableAliases,
        projectDir: options.projectDir,
      })
    ).executable;
  } catch (cause) {
    const untrusted = matches('cli-executable-untrusted')(cause);
    return unresolvedReadiness(tool, Date.now(), untrusted);
  }
  throwIfAborted(options.signal);

  return trackToolCheck(tool, async () => {
    try {
      const result = await probeCliReadiness({
        tool,
        executable,
        probe: lookupCliReadinessProbe({ tool, role: 'planner' }),
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
        auth: result.auth,
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
        probedAt: Date.now(),
      });
    }
  });
}

async function detectCliTool(
  tool: CliToolId,
  options: DetectCliToolDependencies,
): Promise<CliToolDetection> {
  const readiness = await detectCliToolReadiness(tool, options);
  const detection = cliDetectionFromReadiness(readiness);
  // Only the route of a tool that stores no credential decides its seat, so only its selection is read.
  if (readiness.status !== 'unauthenticated' || !includes(PROVIDER_ORACLE_TOOL_IDS, tool)) {
    return detection;
  }
  const selection = await readHostModelSelection(tool);
  return selection === null ? detection : { ...detection, selectedModel: selection.model };
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
    signal: options.signal,
  };
  const tools = options.tools ?? LISTED_CLI_TOOL_IDS;
  return Promise.all(tools.map((tool) => detectCliToolReadiness(tool, dependencies)));
}

export async function detectAvailableCliTools(
  options: DetectCliToolsOptions = {},
): Promise<CliToolDetection[]> {
  const dependencies = {
    projectDir: options.projectDir ?? process.cwd(),
    signal: options.signal,
  };
  const tools = options.tools ?? LISTED_CLI_TOOL_IDS;
  return Promise.all(tools.map((tool) => detectCliTool(tool, dependencies)));
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
  tools?: readonly CliToolId[] | undefined;
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
      tools: options.tools,
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
