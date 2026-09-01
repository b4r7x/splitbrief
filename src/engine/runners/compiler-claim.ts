import { randomUUID } from 'node:crypto';
import { findConfiguredCustomCommand } from '../../core/config/custom-command-catalog.js';
import type { Config } from '../../core/schemas/config.js';
import {
  TaskCompilationOperationIdSchema,
  type TaskCompilationFailure,
  type TaskCompilationOperationId,
} from '../../core/schemas/task-compilation.js';
import {
  COMPILER_SUPPORT_TABLE,
  renderCompilerRefusal,
  type CompilerBackendId,
  type CompilerCapabilityTuple,
  type CompilerConformanceProof,
  type CompilerCredentialChannel,
  type CompilerSupportRow,
} from './compiler-capability.js';
import { platformContainmentProfile, type ContainmentProfileName } from './planner-containment.js';
import { assertNever } from '../../utils/type-guards.js';

export type DeriveCompilerClaimInput = Readonly<{
  config: Config;
  detectedVersion?: string | null | undefined;
  _containmentProfile?: (() => Promise<ContainmentProfileName | 'unavailable'>) | undefined;
}>;

export type CompilerClaimDerivation =
  | Readonly<{
      kind: 'derived';
      claim: CompilerCapabilityTuple;
      operationId: TaskCompilationOperationId;
    }>
  | Readonly<{
      kind: 'refused';
      failure: TaskCompilationFailure;
    }>;

function resolvePlannerBackendId(config: Config): CompilerBackendId {
  const custom = findConfiguredCustomCommand(config, config.planner);
  if (custom !== undefined) return 'custom-command';
  const runner = config.planner;
  switch (runner.kind) {
    case 'cli':
      return runner.tool;
    case 'api':
      return 'api';
    case 'shell':
      return 'shell';
    case 'agent':
      return 'agent';
    default:
      return assertNever(runner);
  }
}

function selectCredentialChannel(
  channels: readonly CompilerCredentialChannel[],
  config: Config,
): CompilerCredentialChannel {
  const runner = config.planner;
  if (runner.kind === 'cli') {
    if (
      'authChannel' in runner &&
      runner.authChannel === 'api-key' &&
      channels.includes('api-key')
    ) {
      return 'api-key';
    }
    if (channels.includes('session-copy')) {
      return 'session-copy';
    }
  }
  if (channels.includes('api-key')) {
    return 'api-key';
  }
  return channels[0] ?? 'session-copy';
}

function refuseDerivation(
  input: Readonly<{
    backend: string;
    claimedVersion: string;
    missing: readonly string[];
    detail: string;
  }>,
): CompilerClaimDerivation {
  const failure = renderCompilerRefusal({ stage: 'capability', ...input });
  return { kind: 'refused', failure };
}

/**
 * The claim's conformance vector. `roleVector`, `terminalProtocol` and
 * `credentialIsolation` are hardcoded `verified` for every row admitted here, never
 * observed at runtime; `containment` is the live observation — a host that offers no
 * launcher the row admits yields an `unverified` vector, which
 * `admitCompilerCapability` refuses alongside `containmentProfile`.
 */
function fixtureConformance(
  row: CompilerSupportRow,
  containmentProfile: string,
): CompilerConformanceProof {
  return {
    roleVector: 'verified',
    terminalProtocol: 'verified',
    containment: row.containmentProfiles.includes(containmentProfile) ? 'verified' : 'unverified',
    credentialIsolation: 'verified',
    fixtureDate: row.fixtureDate,
  };
}

export async function deriveCompilerClaim(
  input: DeriveCompilerClaimInput,
): Promise<CompilerClaimDerivation> {
  const backend = resolvePlannerBackendId(input.config);
  const version = input.detectedVersion ?? '';
  const row = COMPILER_SUPPORT_TABLE[backend];
  if (row.state === 'unsupported') {
    return refuseDerivation({
      backend,
      claimedVersion: version,
      missing: ['backend'],
      detail: row.unsupportedReason ?? 'no admitted compiler posture in V1',
    });
  }
  if (row.versionRequired && !version) {
    return refuseDerivation({
      backend,
      claimedVersion: version,
      missing: ['version'],
      detail: 'no verified runtime version evidence',
    });
  }
  const containmentProfile = await (input._containmentProfile ?? platformContainmentProfile)();
  const credentialChannel = selectCredentialChannel(row.credentialChannels, input.config);
  const transport = row.transports[0] ?? 'stdout-final';
  const operationId = TaskCompilationOperationIdSchema.parse(`operation-${randomUUID()}`);

  const claim: CompilerCapabilityTuple = {
    backend: row.backend,
    version,
    role: 'planner-read-only',
    transport,
    terminalContract: row.terminalContract,
    containmentProfile,
    credentialChannel,
    envelopeVersion: row.envelopeVersion,
    conformance: fixtureConformance(row, containmentProfile),
  };

  return { kind: 'derived', claim, operationId };
}
