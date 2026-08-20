import { vi } from 'vitest';
import { TaskCompilationOperationIdSchema } from '../../../src/core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
} from '../../../src/engine/calls/dispatch-ledger.js';
import type { CompilerSeam } from '../../../src/engine/planners/base.js';
import type { CompilerCapabilityReceipt } from '../../../src/engine/runners/compiler-capability.js';
import { COMPILER_FIXTURE_DATE } from './compiler-capability.js';

const SEAM_IDENTITIES = {
  opencode: {
    executablePath: '/usr/bin/opencode',
    version: '1.18.15',
    runtimeVersion: '1.19.0',
    terminalContract: 'opencode-final-message-v1',
  },
  'claude-code': {
    executablePath: '/usr/bin/claude',
    version: '2.1.232',
    runtimeVersion: '2.1.235',
    terminalContract: 'claude-terminal-result-v1',
  },
} as const;

type CompilerSeamBackend = keyof typeof SEAM_IDENTITIES;

const CAPABILITY_DIGEST = '0'.repeat(64);
const ENVELOPE_BOUND = 1000;

function compilerCapabilityReceipt(backend: CompilerSeamBackend): CompilerCapabilityReceipt {
  const identity = SEAM_IDENTITIES[backend];
  return {
    backend,
    version: identity.version,
    runtimeVersion: identity.runtimeVersion,
    versionObservation: 'drifted',
    role: 'planner-read-only',
    transport: 'stdout-final',
    terminalContract: identity.terminalContract,
    containmentProfile: 'seatbelt',
    credentialChannel: 'session-copy',
    envelopeVersion: 1,
    fixtureDate: COMPILER_FIXTURE_DATE,
    capabilityDigest: CAPABILITY_DIGEST,
  };
}

export function makeCompilerSeam(input: { readonly backend: CompilerSeamBackend }): CompilerSeam {
  const identity = SEAM_IDENTITIES[input.backend];
  const receipt = compilerCapabilityReceipt(input.backend);
  return {
    invocation: {
      runtime: {
        executablePath: identity.executablePath,
        version: identity.version,
        runtimeDigest: 'digest',
        protocolDigest: 'protocol-digest',
      },
      role: 'planner-read-only',
      transport: { kind: 'stdout-final' },
      terminalContract: identity.terminalContract,
      envelope: {
        version: 1,
        promptBytes: ENVELOPE_BOUND,
        inputTokensUpperBound: ENVELOPE_BOUND,
        requestedOutputTokens: ENVELOPE_BOUND,
        outputTokensUpperBound: ENVELOPE_BOUND,
        maxNormalizedOutputBytes: ENVELOPE_BOUND,
        maxDeclaredArtifactBytes: ENVELOPE_BOUND,
        maxRawProtocolBytes: ENVELOPE_BOUND,
        maxStderrBytes: ENVELOPE_BOUND,
        deadlineMs: ENVELOPE_BOUND,
        idleTimeoutMs: ENVELOPE_BOUND,
      },
      capabilityDigest: receipt.capabilityDigest,
    },
    ledger: createTaskDispatchLedger({
      operation: {
        version: 1,
        dispatchLimit: 64,
        callCount: 0,
        totalPromptBytes: 0,
        totalInputTokensUpperBound: 0,
        totalOutputTokensUpperBound: 0,
        totalNormalizedOutputBytes: 0,
        totalDeclaredArtifactBytes: 0,
        callsDigest: 'calls-digest',
      },
      operationId: TaskCompilationOperationIdSchema.parse('operation-compiler-seam-fixture'),
      claimPort: createTaskDispatchClaimPort(),
    }),
    dispatch: vi.fn(),
    receipt,
  };
}
