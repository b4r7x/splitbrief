import {
  CLI_COMPILER_EVIDENCE,
  type CliCompilerSupportState,
  type CliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import {
  TaskCompilationFailureSchema,
  type TaskCompilationCallEnvelope,
  type TaskCompilationFailure,
} from '../../core/schemas/task-compilation.js';
import type { PlannerArtifactTransport } from '../../core/schemas/task-compilation.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { sha256Hex } from '../../utils/sha256.js';

export type CompilerBackendId =
  | CliToolId
  | 'shell'
  | 'agent'
  | 'api'
  | 'agent-sdk'
  | 'custom-command';

export type CompilerCredentialChannel = 'api-key' | 'session-copy';

/**
 * The conformance evidence a candidate must carry for admission. `roleVector`,
 * `terminalProtocol` and `credentialIsolation` are hardcoded `verified` by
 * `deriveCompilerClaim` for every row it admits, never observed at runtime, and
 * `fixtureDate` is the row's hand-maintained date — `scripts/cli-conformance.ts
 * --record` writes a harness record on demand, nothing refreshes the rows from it.
 * `containment` is the one live observation, so a claim `deriveCompilerClaim`
 * produced can fail the conformance arm only together with `containmentProfile`. A
 * partial, drifted, or unverified proof fails closed (REQ-016, REQ-019, REQ-047).
 */
export type CompilerConformanceProof = Readonly<{
  roleVector: 'verified' | 'unverified';
  terminalProtocol: 'verified' | 'unverified';
  containment: 'verified' | 'unverified';
  credentialIsolation: 'verified' | 'unverified';
  fixtureDate: string;
}>;

export type CompilerSupportState = CliCompilerSupportState;

export type CompilerSupportRow = Readonly<{
  backend: CompilerBackendId;
  version: string;
  /**
   * True marks a versioned backend requiring verified runtime version evidence. False marks a
   * versionless backend (api, agent-sdk, custom-command) where no runtime version
   * is required and the verified conformance proof alone carries the identity evidence.
   */
  versionRequired: boolean;
  state: CompilerSupportState;
  transports: readonly PlannerArtifactTransport['kind'][];
  terminalContract: string;
  containmentProfiles: readonly string[];
  credentialChannels: readonly CompilerCredentialChannel[];
  envelopeVersion: TaskCompilationCallEnvelope['version'];
  fixtureDate: string;
  unsupportedReason?: string;
}>;

function supportRow(row: CompilerSupportRow): CompilerSupportRow {
  return Object.freeze({
    ...row,
    transports: Object.freeze([...row.transports]),
    containmentProfiles: Object.freeze([...row.containmentProfiles]),
    credentialChannels: Object.freeze([...row.credentialChannels]),
  });
}

/**
 * The capability-only half of a CLI compiler row: the containment profiles and
 * credential channels the runtime tuple is admitted against. The identity half —
 * state, admitted version, transports, terminal contract, fixture date, and the
 * unsupported reason — is owned by `CLI_COMPILER_EVIDENCE` in the catalog and is
 * never restated here.
 */
type CliCompilerCapability = Readonly<{
  containmentProfiles: readonly string[];
  credentialChannels: readonly CompilerCredentialChannel[];
}>;

const CLI_COMPILER_CAPABILITY: Readonly<Record<CliToolId, CliCompilerCapability>> = Object.freeze({
  opencode: {
    containmentProfiles: ['seatbelt', 'bubblewrap'],
    credentialChannels: ['session-copy'],
  },
  'claude-code': {
    containmentProfiles: ['seatbelt', 'bubblewrap'],
    credentialChannels: ['api-key', 'session-copy'],
  },
  codex: {
    containmentProfiles: ['seatbelt', 'bubblewrap'],
    credentialChannels: ['api-key', 'session-copy'],
  },
  'kilo-code': {
    containmentProfiles: ['seatbelt', 'bubblewrap'],
    credentialChannels: ['session-copy'],
  },
  copilot: { containmentProfiles: [], credentialChannels: [] },
  aider: { containmentProfiles: [], credentialChannels: [] },
  cursor: { containmentProfiles: [], credentialChannels: [] },
});

function cliSupportRow(backend: CliToolId): CompilerSupportRow {
  const evidence = CLI_COMPILER_EVIDENCE[backend];
  const capability = CLI_COMPILER_CAPABILITY[backend];
  return supportRow({
    backend,
    version: evidence.version,
    versionRequired: evidence.version !== '',
    state: evidence.state,
    transports: evidence.transports,
    terminalContract: evidence.terminalContract,
    containmentProfiles: capability.containmentProfiles,
    credentialChannels: capability.credentialChannels,
    envelopeVersion: 1,
    fixtureDate: evidence.fixtureDate,
    ...(evidence.unsupportedReason === undefined
      ? {}
      : { unsupportedReason: evidence.unsupportedReason }),
  });
}

/**
 * The locked V1 support table. The seven CLI rows are built from the catalog's
 * `CLI_COMPILER_EVIDENCE`, which owns their identity evidence; only the
 * non-CLI backends are declared here in full. Supported rows are admitted on valid tuple
 * conformance with tested or drifted version observation; Copilot, Aider, Cursor, and the legacy
 * shell and agent planners are typed-unsupported in V1 and refuse with zero
 * dispatches no matter what a candidate claims. The record has a null
 * prototype, so a lookup by an arbitrary claimed backend id is total: an
 * inherited key such as `__proto__` or `toString` resolves to `undefined`.
 */
export const COMPILER_SUPPORT_TABLE: Readonly<Record<CompilerBackendId, CompilerSupportRow>> =
  Object.freeze({
    __proto__: null,
    opencode: cliSupportRow('opencode'),
    'claude-code': cliSupportRow('claude-code'),
    codex: cliSupportRow('codex'),
    'kilo-code': cliSupportRow('kilo-code'),
    copilot: cliSupportRow('copilot'),
    aider: cliSupportRow('aider'),
    cursor: cliSupportRow('cursor'),
    shell: supportRow({
      backend: 'shell',
      version: '',
      versionRequired: false,
      state: 'unsupported',
      transports: Object.freeze([]),
      terminalContract: 'unsupported',
      containmentProfiles: Object.freeze([]),
      credentialChannels: Object.freeze([]),
      envelopeVersion: 1,
      fixtureDate: '2026-08-15',
      unsupportedReason:
        'legacy shell planner lacks compiler containment and final-response conformance',
    }),
    agent: supportRow({
      backend: 'agent',
      version: '',
      versionRequired: false,
      state: 'unsupported',
      transports: Object.freeze([]),
      terminalContract: 'unsupported',
      containmentProfiles: Object.freeze([]),
      credentialChannels: Object.freeze([]),
      envelopeVersion: 1,
      fixtureDate: '2026-08-15',
      unsupportedReason:
        'legacy agent planner ambient session-file behavior violates exact lease ownership',
    }),
    api: supportRow({
      backend: 'api',
      version: '',
      versionRequired: false,
      state: 'conformance-gated',
      transports: Object.freeze(['stdout-final']),
      terminalContract: 'provider-final-assistant-response-v1',
      containmentProfiles: Object.freeze(['seatbelt', 'bubblewrap']),
      credentialChannels: Object.freeze(['api-key']),
      envelopeVersion: 1,
      fixtureDate: '2026-08-15',
    }),
    'agent-sdk': supportRow({
      backend: 'agent-sdk',
      version: '',
      versionRequired: false,
      state: 'conformance-gated',
      transports: Object.freeze(['stdout-final']),
      terminalContract: 'agent-sdk-final-assistant-turn-v1',
      containmentProfiles: Object.freeze(['seatbelt', 'bubblewrap']),
      credentialChannels: Object.freeze(['api-key']),
      envelopeVersion: 1,
      fixtureDate: '2026-08-15',
    }),
    'custom-command': supportRow({
      backend: 'custom-command',
      version: '',
      versionRequired: false,
      state: 'conformance-gated',
      transports: Object.freeze(['stdout-final', 'declared-file']),
      terminalContract: 'custom-command-final-response-v1',
      containmentProfiles: Object.freeze(['seatbelt', 'bubblewrap']),
      credentialChannels: Object.freeze(['api-key']),
      envelopeVersion: 1,
      fixtureDate: '2026-08-15',
    }),
  });

/**
 * The claimed capability tuple of one candidate compiler call. `role`,
 * `envelopeVersion`, and the conformance fields are deliberately wider than
 * the admitted literals: a hostile claim is a runtime refusal, never a
 * compile-time fiction.
 */
export type CompilerCapabilityTuple = Readonly<{
  backend: CompilerBackendId;
  version: string;
  role: string;
  transport: PlannerArtifactTransport['kind'];
  terminalContract: string;
  containmentProfile: string;
  credentialChannel: CompilerCredentialChannel;
  envelopeVersion: number;
  conformance: CompilerConformanceProof;
}>;

/**
 * Compiler capability receipt (REQ-049): the runtime identity, role
 * vector, transport, terminal contract, containment profile, credential
 * channel, envelope version, and proof fixture date — no secret value or
 * secret-derived hash. `capabilityDigest` binds the non-secret receipt.
 */
export type CompilerCapabilityReceipt = Readonly<{
  backend: CompilerBackendId;
  version: string;
  runtimeVersion: string;
  versionObservation: 'tested' | 'drifted';
  role: 'planner-read-only';
  transport: PlannerArtifactTransport['kind'];
  terminalContract: string;
  containmentProfile: string;
  credentialChannel: CompilerCredentialChannel;
  envelopeVersion: TaskCompilationCallEnvelope['version'];
  fixtureDate: string;
  capabilityDigest: string;
}>;

export type CompilerCapabilityAdmission =
  | Readonly<{ kind: 'admitted'; receipt: CompilerCapabilityReceipt }>
  | RefusedCompilerAdmission;

/**
 * Capability admission fails closed (REQ-016). A dispatch may happen only with
 * an `admitted` receipt; every other combination — unsupported backend,
 * wrong transport or protocol, missing sandbox, unadmitted credential channel,
 * envelope drift, or unverified conformance — returns the typed zero-dispatch
 * refusal `task_compiler_capability_unsupported` and is never downgraded to a
 * weaker mode. Version mismatch on a supported backend admits with a drift
 * receipt (REQ-003), but a row marked `versionRequired` with no claimed runtime
 * version carries no identity evidence at all and refuses.
 */
export function admitCompilerCapability(
  tuple: CompilerCapabilityTuple,
): CompilerCapabilityAdmission {
  const row = COMPILER_SUPPORT_TABLE[tuple.backend];
  if (row === undefined) {
    return refusedCompilerAdmission({
      stage: 'capability',
      backend: tuple.backend,
      claimedVersion: tuple.version,
      missing: ['backend'],
      detail: 'unknown compiler backend id',
    });
  }
  if (row.state === 'unsupported') {
    return refusedCompilerAdmission({
      stage: 'capability',
      backend: row.backend,
      claimedVersion: tuple.version,
      missing: ['backend'],
      ...(row.unsupportedReason === undefined ? {} : { detail: row.unsupportedReason }),
    });
  }
  const missing: string[] = [];
  const versionObservation: 'tested' | 'drifted' =
    tuple.version === row.version ? 'tested' : 'drifted';
  if (row.versionRequired && tuple.version === '') missing.push('version');
  if (tuple.role !== 'planner-read-only') missing.push('role');
  if (!row.transports.includes(tuple.transport)) missing.push('transport');
  if (tuple.terminalContract !== row.terminalContract) missing.push('terminalContract');
  if (!row.containmentProfiles.includes(tuple.containmentProfile)) {
    missing.push('containmentProfile');
  }
  if (!row.credentialChannels.includes(tuple.credentialChannel)) {
    missing.push('credentialChannel');
  }
  if (tuple.envelopeVersion !== row.envelopeVersion) missing.push('envelopeVersion');
  const conformance = tuple.conformance;
  if (
    conformance.roleVector !== 'verified' ||
    conformance.terminalProtocol !== 'verified' ||
    conformance.containment !== 'verified' ||
    conformance.credentialIsolation !== 'verified'
  ) {
    missing.push('conformance');
  } else if (conformance.fixtureDate !== row.fixtureDate) {
    missing.push('fixtureDate');
  }
  if (missing.length > 0) {
    return refusedCompilerAdmission({
      stage: 'capability',
      backend: row.backend,
      claimedVersion: tuple.version,
      missing,
    });
  }
  const receiptBase = {
    backend: row.backend,
    version: row.version,
    runtimeVersion: tuple.version,
    versionObservation,
    // The role check above guarantees the claim; the receipt records the
    // admitted literal, never the claimed string.
    role: 'planner-read-only' as const,
    transport: tuple.transport,
    terminalContract: tuple.terminalContract,
    containmentProfile: tuple.containmentProfile,
    credentialChannel: tuple.credentialChannel,
    envelopeVersion: row.envelopeVersion,
    fixtureDate: tuple.conformance.fixtureDate,
  };
  const receipt: CompilerCapabilityReceipt = {
    ...receiptBase,
    capabilityDigest: sha256Hex(
      canonicalJSON({ domain: 'splitbrief-compiler-capability-v1', ...receiptBase }),
    ),
  };
  return { kind: 'admitted', receipt };
}

/**
 * The single rendering of a zero-dispatch compiler refusal (REQ-016), shared by
 * capability admission, claim derivation, and both runtime-evidence gates. An
 * empty claimed version is omitted from the identity rather than rendered as a
 * trailing space, the unmatched tuple properties are listed once, and an
 * optional detail closes the sentence.
 */
export function renderCompilerRefusal(
  input: Readonly<{
    stage: 'capability' | 'runtime';
    backend: string;
    claimedVersion: string;
    missing: readonly string[];
    detail?: string;
  }>,
): TaskCompilationFailure {
  const identity =
    input.claimedVersion === '' ? input.backend : `${input.backend} ${input.claimedVersion}`;
  const detail = input.detail === undefined ? '' : ` ${input.detail}.`;
  return TaskCompilationFailureSchema.parse({
    code: 'task_compiler_capability_unsupported',
    message: `Compiler ${input.stage} is not admitted for ${identity}: ${input.missing.join(', ')} missing or unverified.${detail}`,
  });
}

/**
 * The refused arm every compiler admission gate returns (REQ-016): the rendered
 * failure plus the exact properties that are missing or do not match. Capability
 * admission and both runtime-evidence gates share this one shape, so a refusal
 * is built in exactly one place.
 */
export type RefusedCompilerAdmission = Readonly<{
  kind: 'refused';
  failure: TaskCompilationFailure;
  missing: readonly string[];
}>;

export function refusedCompilerAdmission(
  input: Readonly<{
    stage: 'capability' | 'runtime';
    backend: string;
    claimedVersion: string;
    missing: readonly string[];
    detail?: string;
  }>,
): RefusedCompilerAdmission {
  return { kind: 'refused', failure: renderCompilerRefusal(input), missing: [...input.missing] };
}
