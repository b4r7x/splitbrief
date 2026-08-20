import type {
  CompilerCapabilityTuple,
  CompilerConformanceProof,
} from '../../../src/engine/runners/compiler-capability.js';

export const COMPILER_FIXTURE_DATE = '2026-08-15';

export function conformanceProof(
  overrides: Readonly<Partial<CompilerConformanceProof>> = {},
): CompilerConformanceProof {
  return {
    roleVector: 'verified',
    terminalProtocol: 'verified',
    containment: 'verified',
    credentialIsolation: 'verified',
    fixtureDate: COMPILER_FIXTURE_DATE,
    ...overrides,
  };
}

export function unverifiedConformanceProof(): CompilerConformanceProof {
  return conformanceProof({
    roleVector: 'unverified',
    terminalProtocol: 'unverified',
    containment: 'unverified',
    credentialIsolation: 'unverified',
  });
}

const CAPABILITY_IDENTITIES = {
  opencode: {
    version: '1.18.15',
    transport: 'stdout-final',
    terminalContract: 'opencode-final-message-v1',
    credentialChannel: 'session-copy',
  },
  'claude-code': {
    version: '2.1.232',
    transport: 'stdout-final',
    terminalContract: 'claude-terminal-result-v1',
    credentialChannel: 'api-key',
  },
  codex: {
    version: '0.147.0',
    transport: 'declared-file',
    terminalContract: 'codex-output-last-message-v1',
    credentialChannel: 'api-key',
  },
  'kilo-code': {
    version: '7.0.49',
    transport: 'stdout-final',
    terminalContract: 'kilo-final-message-v1',
    credentialChannel: 'session-copy',
  },
  api: {
    version: '',
    transport: 'stdout-final',
    terminalContract: 'provider-final-assistant-response-v1',
    credentialChannel: 'api-key',
  },
  'agent-sdk': {
    version: '',
    transport: 'stdout-final',
    terminalContract: 'agent-sdk-final-assistant-turn-v1',
    credentialChannel: 'api-key',
  },
  'custom-command': {
    version: '',
    transport: 'stdout-final',
    terminalContract: 'custom-command-final-response-v1',
    credentialChannel: 'api-key',
  },
} as const satisfies Readonly<
  Record<
    string,
    Pick<
      CompilerCapabilityTuple,
      'version' | 'transport' | 'terminalContract' | 'credentialChannel'
    >
  >
>;

type CompilerFixtureBackend = keyof typeof CAPABILITY_IDENTITIES;

export function capabilityTuple(
  backend: CompilerFixtureBackend,
  overrides: Readonly<Partial<CompilerCapabilityTuple>> = {},
): CompilerCapabilityTuple {
  const identity = CAPABILITY_IDENTITIES[backend];
  return {
    backend,
    version: identity.version,
    role: 'planner-read-only',
    transport: identity.transport,
    terminalContract: identity.terminalContract,
    containmentProfile: 'seatbelt',
    credentialChannel: identity.credentialChannel,
    envelopeVersion: 1,
    conformance: conformanceProof(),
    ...overrides,
  };
}
