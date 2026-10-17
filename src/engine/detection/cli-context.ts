import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import { contentIdentityId } from '../../core/config/accessors/content-identity.js';
import type { RunnerRole } from '../../core/runners/seat-roles.js';
import type { Config } from '../../core/schemas/config.js';
import type { ImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';
import { resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import type {
  CliExecutableIdentity,
  CliExecutableReceipt,
} from '../../core/discovery/detection.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';

export type CliRunnerDiscoveryContext = RunnerDiscoveryContext &
  Readonly<{ kind: 'cli'; id: CliToolId }>;

/**
 * The context one CLI seat is probed under. It names the configuration being
 * checked, not the caller: two probes of one config ask the tool one question.
 */
export function cliSeatDiscoveryContext(
  input: Readonly<{
    role: RunnerRole;
    runner: Extract<PlannerConfig | ImplementerConfig, { kind: 'cli' }>;
    config: Config;
  }>,
): CliRunnerDiscoveryContext {
  return {
    role: input.role,
    kind: 'cli',
    id: input.runner.tool,
    ...(input.runner.model !== undefined && { model: input.runner.model }),
    authChannel: resolveCliRunnerAuth(input.runner).id,
    credentialPresent: false,
    configGeneration: contentIdentityId('config', input.config),
  };
}

function snapshotCredentialDomain(
  credentialDomain: RunnerDiscoveryContext['credentialDomain'],
): RunnerDiscoveryContext['credentialDomain'] {
  if (credentialDomain === undefined) return undefined;
  const credentialSource =
    credentialDomain.credentialSource.kind === 'env'
      ? Object.freeze({
          kind: 'env' as const,
          name: credentialDomain.credentialSource.name,
        })
      : Object.freeze({
          kind: 'inline' as const,
          configNodeId: credentialDomain.credentialSource.configNodeId,
        });
  return Object.freeze({
    providerId: credentialDomain.providerId,
    endpointOrigin: credentialDomain.endpointOrigin,
    authChannel: credentialDomain.authChannel,
    credentialSource,
    configGeneration: credentialDomain.configGeneration,
  });
}

export function snapshotCliContext(context: CliRunnerDiscoveryContext): CliRunnerDiscoveryContext {
  const credentialDomain = snapshotCredentialDomain(context.credentialDomain);
  return Object.freeze({
    role: context.role,
    ...(context.seatRole === undefined ? {} : { seatRole: context.seatRole }),
    kind: 'cli' as const,
    id: context.id,
    ...(context.model === undefined ? {} : { model: context.model }),
    ...(context.authChannel === undefined ? {} : { authChannel: context.authChannel }),
    ...(context.endpointOrigin === undefined ? {} : { endpointOrigin: context.endpointOrigin }),
    ...(context.endpointIdentity === undefined
      ? {}
      : { endpointIdentity: context.endpointIdentity }),
    credentialPresent: context.credentialPresent,
    ...(credentialDomain === undefined ? {} : { credentialDomain }),
    configGeneration: context.configGeneration,
  });
}

export function isCredentialFreeCliContext(context: CliRunnerDiscoveryContext): boolean {
  return context.configGeneration.trim().length > 0 && context.credentialDomain === undefined;
}

export function immutableCliExecutableReceipt(receipt: CliExecutableReceipt): CliExecutableReceipt {
  return Object.freeze({
    path: receipt.path,
    fingerprint: Object.freeze({ ...receipt.fingerprint }),
    executableIdentity: Object.freeze({ ...receipt.executableIdentity }),
  });
}

export function richCliExecutable(
  executable: CliExecutableIdentity,
): CliExecutableReceipt | undefined {
  const result = CliExecutableReceiptSchema.safeParse(executable);
  return result.success ? result.data : undefined;
}

const DETECTION_RUNTIME_NAMESPACE_PREFIX = 'splitbrief-detection-runtime-v1';

/**
 * The identity/cache namespace shared by detection rows, the catalog operation
 * cache, readiness, and dispatch: the digest-bound runtime receipt identity
 * (REQ-019, REQ-049). A metadata-only identity — a fake loader with no
 * digest-bound receipt — has no namespace and therefore no admitted dispatch;
 * a receipt whose content no longer matches the on-disk binary derives a
 * different namespace at re-read time and fails closed.
 */
export function detectionRuntimeNamespace(executable: CliExecutableIdentity): string | undefined {
  const receipt = richCliExecutable(executable);
  if (receipt === undefined) return undefined;
  return `${DETECTION_RUNTIME_NAMESPACE_PREFIX}:${receipt.executableIdentity.fingerprint}`;
}

export function immutableCliExecutableIdentity(
  executable: CliExecutableIdentity,
): CliExecutableIdentity {
  const receipt = richCliExecutable(executable);
  if (receipt !== undefined) return immutableCliExecutableReceipt(receipt);
  return Object.freeze({
    path: executable.path,
    fingerprint: Object.freeze({ ...executable.fingerprint }),
  });
}
