import { describe, expect, it } from 'vitest';
import {
  OPENAI_COMPAT_STANDARD_FINISH_REASONS,
  type OpenAICompatPolicy,
} from '../../src/engine/providers/openai-compat-policy.js';
import {
  CandidateEvidence,
  RawProviderCandidateContract,
  UnregisteredProviderCandidate,
  baseUrlEnvironmentName,
  canonicalJson,
  contractSha256,
  normalizeCandidateEvidence,
  requiresLiveModelDiscovery,
} from '../../src/engine/providers/candidate-contract.js';
import {
  CLI_PROMPT_SENTINEL,
  CliConformanceCandidatesSchema,
  RawCliCandidateContract,
  UnregisteredCliCandidate,
  replacePromptSentinel,
} from '../../src/engine/runners/cli-tools/candidate-contract.js';

const policy: OpenAICompatPolicy = {
  tokenField: 'max_tokens',
  streamUsage: true,
  temperature: 'verbatim',
  effort: 'omit',
  reasoning: 'omit',
  extraBody: undefined,
  finishReasons: OPENAI_COMPAT_STANDARD_FINISH_REASONS,
};

const providerContract = {
  id: 'example-provider',
  service: 'example',
  offering: 'payg' as const,
  roles: ['planner', 'implementer'] as const,
  endpointPolicy: {
    kind: 'fixed-origin' as const,
    baseURL: 'https://api.example.test/v1',
  },
  credentialEnv: 'EXAMPLE_API_KEY',
  credentialPrefix: 'ex-',
  modelIds: ['example-model'],
  rawRequest: {
    stream: true,
    includeUsage: true,
    tokenField: 'max_tokens' as const,
    max: 8_192,
  },
  expectedRawTerminal: 'finish_reason',
  asOf: '2026-07-31',
};

const descriptor = {
  id: 'example-provider',
  service: 'example',
  offering: 'payg' as const,
  roles: ['planner', 'implementer'] as const,
  endpointPolicy: providerContract.endpointPolicy,
  credentialEnv: 'EXAMPLE_API_KEY',
  credentialPrefix: 'ex-',
  billing: 'api-metered' as const,
  compatibility: 'unverified' as const,
  dataUse: 'unreviewed' as const,
  privacyURL: 'https://example.test/privacy',
  termsURL: 'https://example.test/terms',
  asOf: '2026-07-31',
};

function adapter(role: 'planner' | 'implementer') {
  return {
    descriptor: { id: 'example-cli' },
    role,
    promptTransport: { kind: 'argv' as const, maxBytes: 120_000, placement: 'positional' as const },
    buildArgs: () => [CLI_PROMPT_SENTINEL],
    validateArgs: () => ({ valid: true as const }),
    environment: {},
    outputContract: { kind: 'text-exit' as const, successfulExitCodes: [0] as const },
    parse: () => [],
    terminal: () => null,
    probe: {
      version: {
        command: ['example-cli', '--version'] as const,
        cwd: 'neutral' as const,
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      },
      auth: {
        command: ['example-cli', 'auth'] as const,
        cwd: 'neutral' as const,
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      },
    },
  };
}

describe('typed candidate contracts', () => {
  it('parses a strict provider contract and rejects unknown fields', () => {
    expect(RawProviderCandidateContract.parse(providerContract)).toEqual(providerContract);
    expect(
      RawProviderCandidateContract.safeParse({ ...providerContract, unexpected: true }).success,
    ).toBe(false);
    expect(
      RawProviderCandidateContract.safeParse({
        ...providerContract,
        endpointPolicy: { kind: 'fixed-origin', baseURL: 'http://api.example.test/v1' },
      }).success,
    ).toBe(false);
  });

  it('imports and retains the canonical compatibility policy by identity', () => {
    const candidate = UnregisteredProviderCandidate.parse({
      rawContract: providerContract,
      descriptor,
      knownModels: [{ name: 'example-model' }],
      policy,
    });
    expect(candidate.policy).toBe(policy);
    expect(candidate.rawContract.modelIds).toEqual(['example-model']);
  });

  it('allows local optional credentials and marks empty models for live discovery', () => {
    const local = RawProviderCandidateContract.parse({
      ...providerContract,
      id: 'local-model-server',
      service: 'local-model-server',
      offering: 'local',
      roles: ['implementer'],
      endpointPolicy: { kind: 'loopback', defaultBaseURL: 'http://localhost:8080/v1' },
      credentialEnv: null,
      credentialPrefix: null,
      modelIds: [],
    });
    expect(requiresLiveModelDiscovery(local)).toBe(true);
    expect(local.credentialEnv).toBeNull();
  });

  it('derives deterministic allowed-HTTPS base env names', () => {
    const allowed = RawProviderCandidateContract.parse({
      ...providerContract,
      id: 'mimo-token-plan',
      endpointPolicy: {
        kind: 'allowed-https',
        hosts: ['token-plan-cn.xiaomimimo.com'],
        pathSuffix: '/v1',
      },
    });
    expect(baseUrlEnvironmentName(allowed.id)).toBe('MIMO_TOKEN_PLAN_BASE_URL');
  });

  it('keeps canonical JSON and SHA-256 stable across object key order', () => {
    const left = { b: 2, a: { y: true, x: ['é', '终'] } };
    const right = { a: { x: ['é', '终'], y: true }, b: 2 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(contractSha256(left)).toBe(contractSha256(right));
  });

  it('redacts bounded evidence and requires production evidence for PASS', () => {
    const raw = {
      candidateId: 'example-cli',
      role: 'implementer' as const,
      contractSha256: 'a'.repeat(64),
      stdout: 'Authorization: Bearer very-secret-token /Users/private/project',
      stderr: 'API_KEY=secret-value',
    };
    expect(
      CandidateEvidence.safeParse({ rawCapture: raw, productionConformance: null, verdict: 'PASS' })
        .success,
    ).toBe(false);
    const evidence = normalizeCandidateEvidence({ rawCapture: raw, verdict: 'OMIT' });
    expect(evidence.rawCapture.stdout).not.toContain('very-secret-token');
    expect(evidence.rawCapture.stderr).not.toContain('secret-value');
    expect(evidence.rawCapture.stdout).not.toContain('/Users/private');
  });
});

describe('role-singular CLI contracts and prompt transport', () => {
  const base = {
    id: 'example-cli',
    command: 'example-cli',
    role: 'implementer' as const,
    versionArgs: ['--version'],
    auth: { kind: 'env-or-native', env: ['EXAMPLE_API_KEY'] },
    rawInvocation: ['run', CLI_PROMPT_SENTINEL],
    promptTransport: 'argv' as const,
    expectedRawTerminal: 'result',
    asOf: '2026-07-31',
  };

  it('accepts exactly one standalone argv sentinel and preserves a multibyte prompt', () => {
    const contract = RawCliCandidateContract.parse(base);
    const prompt = 'Zażółć gęślą jaźń — 最后一行 sentinel';
    expect(replacePromptSentinel(contract.rawInvocation, prompt, contract.promptTransport)).toEqual(
      ['run', prompt],
    );
  });

  it.each([
    ['zero sentinel', []],
    ['duplicate sentinel', [CLI_PROMPT_SENTINEL, CLI_PROMPT_SENTINEL]],
    ['embedded sentinel', ['prefix-<PROMPT>']],
    ['alternate placeholder', ['<MESSAGE>']],
  ])('rejects %s in argv transport', (_label, rawInvocation) => {
    expect(RawCliCandidateContract.safeParse({ ...base, rawInvocation }).success).toBe(false);
  });

  it.each(['stdin', 'file'] as const)('rejects sentinels for %s transport', (promptTransport) => {
    expect(
      RawCliCandidateContract.safeParse({
        ...base,
        promptTransport,
        rawInvocation: ['run'],
      }).success,
    ).toBe(true);
    expect(
      RawCliCandidateContract.safeParse({
        ...base,
        promptTransport,
        rawInvocation: ['run', CLI_PROMPT_SENTINEL],
      }).success,
    ).toBe(false);
  });

  it('requires one literal role and a matching canonical hash and adapter', () => {
    const rawContract = RawCliCandidateContract.parse(base);
    const candidate = {
      id: 'example-cli',
      role: 'implementer' as const,
      rawContract,
      contractSha256: contractSha256(rawContract),
      adapter: adapter('implementer'),
    };
    expect(UnregisteredCliCandidate.parse(candidate)).toMatchObject({
      id: 'example-cli',
      role: 'implementer',
    });
    expect(
      UnregisteredCliCandidate.safeParse({ ...candidate, contractSha256: 'b'.repeat(64) }).success,
    ).toBe(false);
    expect(CliConformanceCandidatesSchema.safeParse([candidate, candidate]).success).toBe(false);
  });
});
