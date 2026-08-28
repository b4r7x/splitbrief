import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import type { CliExecutableReceipt } from '../../core/discovery/detection.js';
import {
  CLI_TOOL_CATALOG,
  classifyCliCompilerVersion,
  isCliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import type { PlannerArtifactTransport } from '../../core/schemas/task-compilation.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { sha256Hex } from '../../utils/sha256.js';
import {
  COMPILER_SUPPORT_TABLE,
  refusedCompilerAdmission,
  type CompilerBackendId,
  type RefusedCompilerAdmission,
} from './compiler-capability.js';

/**
 * The immutable runtime evidence of one compiler call (REQ-019, REQ-049): the
 * digest-bound identity of the exact executable that will run, frozen together
 * with the exact admitted runtime version and protocol row. Readiness and
 * dispatch must use this same evidence; it records no secret value.
 */
export type CompilerRuntimeEvidence = Readonly<{
  backend: CompilerBackendId;
  /** The admitted runtime version of the bound backend. */
  version: string;
  runtimeVersion: string;
  versionObservation: 'tested' | 'drifted';
  executable: CliExecutableReceipt;
  transports: readonly PlannerArtifactTransport['kind'][];
  terminalContract: string;
  fixtureDate: string;
  /**
   * Domain-separated digest over the non-secret runtime tuple; excludes the
   * resolve timestamp so identical binaries bind identically.
   */
  evidenceDigest: string;
}>;

export type CompilerRuntimeAdmission =
  | Readonly<{ kind: 'bound'; evidence: CompilerRuntimeEvidence }>
  | RefusedCompilerAdmission;

function compilerRuntimeDigest(evidence: Omit<CompilerRuntimeEvidence, 'evidenceDigest'>): string {
  return sha256Hex(
    canonicalJSON({
      domain: 'splitbrief-compiler-runtime-v1',
      backend: evidence.backend,
      version: evidence.version,
      runtimeVersion: evidence.runtimeVersion,
      versionObservation: evidence.versionObservation,
      executable: {
        path: evidence.executable.path,
        fingerprint: evidence.executable.fingerprint,
        executableIdentity: {
          canonicalPath: evidence.executable.executableIdentity.canonicalPath,
          realPath: evidence.executable.executableIdentity.realPath,
          platformFileId: evidence.executable.executableIdentity.platformFileId,
          fingerprint: evidence.executable.executableIdentity.fingerprint,
        },
      },
      transports: evidence.transports,
      terminalContract: evidence.terminalContract,
      fixtureDate: evidence.fixtureDate,
    }),
  );
}

/**
 * Resolves the real executable/runtime/protocol once (REQ-019): binds a
 * digest-bound executable receipt to its support-table row. Classification
 * 'exact' binds with observation 'tested'; non-exact for a supported backend
 * binds with observation 'drifted'; unsupported backends fail closed with a
 * typed zero-dispatch refusal.
 */
export function bindCompilerRuntimeEvidence(
  input: Readonly<{
    backend: CompilerBackendId;
    executable: CliExecutableReceipt;
    version: string;
  }>,
): CompilerRuntimeAdmission {
  const row = COMPILER_SUPPORT_TABLE[input.backend];
  if (row.state === 'unsupported') {
    return refusedCompilerAdmission({
      stage: 'runtime',
      backend: row.backend,
      claimedVersion: input.version,
      missing: ['backend'],
      ...(row.unsupportedReason === undefined ? {} : { detail: row.unsupportedReason }),
    });
  }
  const receipt = CliExecutableReceiptSchema.safeParse(input.executable);
  if (!receipt.success) {
    return refusedCompilerAdmission({
      stage: 'runtime',
      backend: row.backend,
      claimedVersion: input.version,
      missing: ['executable'],
    });
  }
  const classification = classifyCliCompilerVersion({
    installedVersion: input.version,
    exactAdmittedVersion: row.version,
    ...(isCliToolId(row.backend)
      ? { versionScheme: CLI_TOOL_CATALOG[row.backend].compatibility.versionScheme }
      : {}),
  });
  const versionObservation: 'tested' | 'drifted' =
    classification === 'exact' ? 'tested' : 'drifted';
  const base = {
    backend: row.backend,
    version: row.version,
    runtimeVersion: input.version,
    versionObservation,
    executable: receipt.data,
    transports: row.transports,
    terminalContract: row.terminalContract,
    fixtureDate: row.fixtureDate,
  };
  return { kind: 'bound', evidence: { ...base, evidenceDigest: compilerRuntimeDigest(base) } };
}
