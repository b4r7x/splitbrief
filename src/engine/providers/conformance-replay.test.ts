import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import { assemblePickerDescriptors } from '../../features/runners/model-catalog/options.js';
import {
  CandidateEvidence,
  RawProviderCandidateContract,
  UnregisteredProviderCandidate,
  contractSha256,
} from './candidate-contract.js';
import type { OpenAICompatPolicy } from './openai-compat-policy.js';
import { resolveOpenAICompatPolicy } from './openai-compat-policy.js';
import { PROVIDER_CONFORMANCE_EXIT_CODES } from './conformance.js';
import { runProductionProviderConformance } from './conformance-production.js';
import { createUnregisteredOpenAICompatProvider } from './unregistered-provider.js';
import { KNOWN_PROVIDERS, getProvider } from './registry.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');

const OPENAI_COMPAT_POLICY_FIELD_NAMES = [
  'tokenField',
  'streamUsage',
  'temperature',
  'effort',
  'reasoning',
  'extraBody',
  'finishReasons',
] as const satisfies readonly (keyof OpenAICompatPolicy)[];

const PRODUCTION_REPLAY_CAPTURED_FIELDS = [
  'candidate',
  'model',
  'status',
  'textBytes',
  'usage',
  'terminal',
  'cancellationProbe',
  'redirectPolicy',
  'errorDiagnostics',
] as const;

type VerdictTaskId =
  | 'T-044'
  | 'T-045'
  | 'T-046'
  | 'T-047'
  | 'T-048'
  | 'T-049'
  | 'T-050'
  | 'T-051'
  | 'T-052'
  | 'T-053';

interface ProviderReplayRow {
  readonly taskId: VerdictTaskId;
  readonly candidateId: string;
  readonly contract: RawProviderCandidateContract;
  readonly capturedContractSha256: string;
  readonly evidencePath: string;
  readonly candidateSource?: string;
  readonly candidateTest?: string;
  readonly omitFromCatalog: boolean;
}

function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

function parseContract(value: unknown): RawProviderCandidateContract {
  return RawProviderCandidateContract.parse(value);
}

function isPassCandidateId(row: ProviderReplayRow): boolean {
  return readEvidenceJson(row.evidencePath).verdict === 'PASS';
}

function assertPickerAbsent(candidateId: string): void {
  const apiIds = assemblePickerDescriptors()
    .filter((entry) => entry.kind === 'api')
    .map((entry) => entry.descriptor.id);
  expect(apiIds).not.toContain(candidateId);
}

function assertCatalogAbsent(candidateId: string): void {
  expect(API_PROVIDER_CATALOG).not.toHaveProperty(candidateId);
  expect(KNOWN_PROVIDERS).not.toHaveProperty(candidateId);
  assertPickerAbsent(candidateId);
}

function readEvidenceJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolveRepoPath(relativePath), 'utf8')) as Record<string, unknown>;
}

function credentialEnvForContract(contract: RawProviderCandidateContract): string {
  const env = contract.credentialEnv;
  if (env === null || env === undefined) return 'REPLAY_CREDENTIAL_ENV';
  return env;
}

const streamBody = [
  'data: {"id":"chatcmpl-replay","choices":[{"delta":{"content":"done"},"finish_reason":null}],"usage":null}\n\n',
  'data: {"id":"chatcmpl-replay","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n',
  'data: [DONE]\n\n',
].join('');

function fakeFetchForContract(contract: RawProviderCandidateContract) {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const endpoint =
    contract.endpointPolicy.kind === 'fixed-origin'
      ? contract.endpointPolicy.baseURL.replace(/\/$/, '')
      : contract.endpointPolicy.kind === 'loopback'
        ? contract.endpointPolicy.defaultBaseURL.replace(/\/$/, '')
        : 'https://token-plan-cn.xiaomimimo.com/v1';
  const fetchImplementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = request.method === 'POST' ? await request.text() : '';
    requests.push({ url: request.url, method: request.method, body });
    if (request.url.includes('/models')) {
      const model = contract.modelIds[0] ?? 'discovered-model';
      return new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200 });
    }
    if (request.url.includes('/chat/completions')) {
      return new Response(streamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImplementation, requests, endpoint };
}

function assertClosedPolicySurface(policy: OpenAICompatPolicy): void {
  expect(Object.keys(policy).sort()).toEqual([...OPENAI_COMPAT_POLICY_FIELD_NAMES].sort());
}

function assertProductionReplayCapturesPolicy(
  policy: OpenAICompatPolicy,
  requestBody: string,
): void {
  const parsed = JSON.parse(requestBody) as Record<string, unknown>;
  if (policy.tokenField === 'max_completion_tokens') {
    expect(parsed).toHaveProperty('max_completion_tokens');
    expect(parsed).not.toHaveProperty('max_tokens');
  } else {
    expect(parsed).toHaveProperty('max_tokens');
    expect(parsed).not.toHaveProperty('max_completion_tokens');
  }
  if (policy.streamUsage) {
    expect(parsed.stream_options).toEqual({ include_usage: true });
  } else {
    expect(parsed).not.toHaveProperty('stream_options');
  }
  if (policy.temperature === 'verbatim') {
    expect(parsed).toHaveProperty('temperature');
  } else {
    expect(parsed).not.toHaveProperty('temperature');
  }
  if (policy.reasoning === 'reasoning_effort') {
    expect(parsed).toHaveProperty('reasoning_effort');
  } else {
    expect(parsed).not.toHaveProperty('reasoning_effort');
  }
  if (policy.extraBody !== undefined) {
    for (const [key, value] of Object.entries(policy.extraBody)) {
      expect(parsed[key]).toEqual(value);
    }
  }
  assertClosedPolicySurface(policy);
}

function parseProductionStdout(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function assertCapturedProductionShape(stdout: string): void {
  const captured = parseProductionStdout(stdout);
  expect(Object.keys(captured).sort()).toEqual([...PRODUCTION_REPLAY_CAPTURED_FIELDS].sort());
  expect(captured.terminal).toBe(true);
  expect(captured.cancellationProbe).toBe('pre-aborted-signal-tested-by-shared-stream');
  expect(captured.redirectPolicy).toBe('same-origin-only');
  expect(captured.errorDiagnostics).toBe('sanitized');
}

const REPLAY_ROWS: readonly ProviderReplayRow[] = [
  {
    taskId: 'T-044',
    candidateId: 'mistral',
    contract: parseContract({
      id: 'mistral',
      service: 'mistral',
      offering: 'payg',
      roles: ['implementer'],
      endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.mistral.ai/v1' },
      credentialEnv: 'MISTRAL_API_KEY',
      credentialPrefix: null,
      modelIds: ['mistral-small-2603'],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_tokens',
        max: 8192,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: '7dcd95766ac97f4cc068274646a93ba41cc480c593f97a9008a05c31f72e44fe',
    evidencePath: 'testing/fixtures/provider-conformance/mistral.json',
    candidateSource: 'src/engine/providers/candidates/mistral.ts',
    candidateTest: 'src/engine/providers/candidates/mistral.test.ts',
    omitFromCatalog: true,
  },
  {
    taskId: 'T-045',
    candidateId: 'gemini',
    contract: parseContract({
      id: 'gemini',
      service: 'gemini',
      offering: 'free-quota',
      roles: ['implementer'],
      endpointPolicy: {
        kind: 'fixed-origin',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      },
      credentialEnv: 'GEMINI_API_KEY',
      credentialPrefix: null,
      modelIds: ['gemini-3.5-flash'],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_tokens',
        max: 65536,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: 'ad14af661ef20fb865a92f813c2977d7770845c344264286208d95686029aa2e',
    evidencePath: 'testing/fixtures/provider-conformance/gemini.json',
    candidateSource: 'src/engine/providers/candidates/gemini.ts',
    candidateTest: 'src/engine/providers/candidates/gemini.test.ts',
    omitFromCatalog: true,
  },
  {
    taskId: 'T-046',
    candidateId: 'cerebras',
    contract: parseContract({
      id: 'cerebras',
      service: 'cerebras',
      offering: 'payg',
      roles: ['implementer'],
      endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.cerebras.ai/v1' },
      credentialEnv: 'CEREBRAS_API_KEY',
      credentialPrefix: null,
      modelIds: ['gpt-oss-120b'],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_tokens',
        max: 40960,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: 'd65814cb86431001c6e1bd61299eaa1382614cd84459227d6b6dec5128ad2284',
    evidencePath: 'testing/fixtures/provider-conformance/cerebras.json',
    candidateSource: 'src/engine/providers/candidates/cerebras.ts',
    candidateTest: 'src/engine/providers/candidates/cerebras.test.ts',
    omitFromCatalog: true,
  },
  {
    taskId: 'T-047',
    candidateId: 'zai',
    contract: parseContract({
      id: 'zai',
      service: 'zai',
      offering: 'payg',
      roles: ['implementer'],
      endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.z.ai/api/paas/v4' },
      credentialEnv: 'ZAI_API_KEY',
      credentialPrefix: null,
      modelIds: ['glm-4.7-flash', 'glm-4.7-flashx'],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_tokens',
        max: 131072,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: '4582d4b5417697fdc8f2232ada3db9dc072c5adc0a37d1b63ffd8a22c5b6ba6f',
    evidencePath: 'testing/fixtures/provider-conformance/zai.json',
    candidateSource: 'src/engine/providers/candidates/zai.ts',
    candidateTest: 'src/engine/providers/candidates/zai.test.ts',
    omitFromCatalog: true,
  },
  {
    taskId: 'T-048',
    candidateId: 'mimo',
    contract: parseContract({
      id: 'mimo',
      service: 'mimo',
      offering: 'payg',
      roles: ['implementer'],
      endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.xiaomimimo.com/v1' },
      credentialEnv: 'MIMO_API_KEY',
      credentialPrefix: 'sk-',
      modelIds: ['mimo-v2.5', 'mimo-v2.5-pro'],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_completion_tokens',
        max: 131072,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: '7b537b7259c8c61059f31daa20fe92857e6a96ed7968d67730c2e20b6dd1e005',
    evidencePath: 'testing/fixtures/provider-conformance/mimo.json',
    candidateSource: 'src/engine/providers/candidates/mimo.ts',
    candidateTest: 'src/engine/providers/candidates/mimo.test.ts',
    omitFromCatalog: true,
  },
  {
    taskId: 'T-049',
    candidateId: 'mimo-token-plan',
    contract: parseContract({
      id: 'mimo-token-plan',
      service: 'mimo',
      offering: 'coding-subscription',
      roles: ['implementer'],
      endpointPolicy: {
        kind: 'allowed-https',
        hosts: [
          'token-plan-cn.xiaomimimo.com',
          'token-plan-sgp.xiaomimimo.com',
          'token-plan-ams.xiaomimimo.com',
        ],
        pathSuffix: '/v1',
      },
      credentialEnv: 'MIMO_TOKEN_PLAN_API_KEY',
      credentialPrefix: 'tp-',
      modelIds: ['mimo-v2.5', 'mimo-v2.5-pro'],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_completion_tokens',
        max: 131072,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: 'c7756d5b151cef25a5a5304594daf4fdef82865d548c5508c087a79615447385',
    evidencePath: 'testing/fixtures/provider-conformance/mimo-token-plan.json',
    candidateSource: 'src/engine/providers/candidates/mimo-token-plan.ts',
    candidateTest: 'src/engine/providers/candidates/mimo-token-plan.test.ts',
    omitFromCatalog: true,
  },
  {
    taskId: 'T-050',
    candidateId: 'minimax',
    contract: parseContract({
      id: 'minimax',
      service: 'minimax',
      offering: 'payg',
      roles: ['implementer'],
      endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.minimax.io/v1' },
      credentialEnv: 'MINIMAX_API_KEY',
      credentialPrefix: null,
      modelIds: ['MiniMax-M3'],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_completion_tokens',
        max: 8192,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: '7c92b5e17427d1da21af8b17727012e1c4267ea52dc2622b7012552a877c7594',
    evidencePath: 'testing/fixtures/provider-conformance/minimax.json',
    candidateSource: 'src/engine/providers/candidates/minimax.ts',
    candidateTest: 'src/engine/providers/candidates/minimax.test.ts',
    omitFromCatalog: true,
  },
  {
    taskId: 'T-051',
    candidateId: 'moonshot',
    contract: parseContract({
      id: 'moonshot',
      service: 'moonshot',
      offering: 'payg',
      roles: ['implementer'],
      endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://api.moonshot.ai/v1' },
      credentialEnv: 'MOONSHOT_API_KEY',
      credentialPrefix: null,
      modelIds: ['kimi-k2.7-code'],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_completion_tokens',
        max: 8192,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: 'd8ef6c7440ebc8761d1f81bcec1197cd242228327a364ea3fad743b481d53af4',
    evidencePath: 'testing/fixtures/provider-conformance/moonshot.json',
    candidateSource: 'src/engine/providers/candidates/moonshot.ts',
    candidateTest: 'src/engine/providers/candidates/moonshot.test.ts',
    omitFromCatalog: true,
  },
  {
    taskId: 'T-052',
    candidateId: 'dashscope',
    contract: parseContract({
      id: 'dashscope',
      service: 'dashscope',
      offering: 'payg',
      roles: ['implementer'],
      endpointPolicy: {
        kind: 'allowed-https',
        hosts: [
          '{workspaceId}.ap-southeast-1.maas.aliyuncs.com',
          '{workspaceId}.eu-central-1.maas.aliyuncs.com',
        ],
        pathSuffix: '/compatible-mode/v1',
      },
      credentialEnv: 'DASHSCOPE_API_KEY',
      credentialPrefix: null,
      modelIds: ['qwen3.7-plus'],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_tokens',
        max: 65536,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: 'a9bf7005e02b539b5d759f5d60c6b58290fbeace73f3b7c7f60e813bde8a1be6',
    evidencePath: 'testing/fixtures/provider-conformance/dashscope.json',
    candidateSource: 'src/engine/providers/candidates/dashscope.ts',
    candidateTest: 'src/engine/providers/candidates/dashscope.test.ts',
    omitFromCatalog: true,
  },
  {
    taskId: 'T-053',
    candidateId: 'llama-cpp',
    contract: parseContract({
      id: 'llama-cpp',
      service: 'llama-cpp',
      offering: 'local',
      roles: ['implementer'],
      endpointPolicy: { kind: 'loopback', defaultBaseURL: 'http://localhost:8080/v1' },
      credentialEnv: 'LLAMA_CPP_API_KEY',
      credentialPrefix: null,
      modelIds: [],
      rawRequest: {
        stream: true,
        includeUsage: true,
        tokenField: 'max_tokens',
        max: 8192,
      },
      expectedRawTerminal: 'finish_reason',
      asOf: '2026-07-31',
    }),
    capturedContractSha256: 'db64cb827ba96c32a65dc2292f1a992709ca0794dfea94bd973396256e3180d0',
    evidencePath: 'testing/fixtures/provider-conformance/llama-cpp.json',
    candidateSource: 'src/engine/providers/llama-cpp.ts',
    candidateTest: 'src/engine/providers/llama-cpp.test.ts',
    omitFromCatalog: true,
  },
];

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'splitbrief-provider-replay-'));
  tempDirectories.push(directory);
  return directory;
}

function validateCapturedEvidence(row: ProviderReplayRow): void {
  const evidence = readEvidenceJson(row.evidencePath);
  expect(row.capturedContractSha256).toBe(contractSha256(row.contract));
  const rawCapture = evidence.rawCapture as Record<string, unknown> | undefined;
  expect(rawCapture).toBeDefined();
  if (rawCapture === undefined) return;
  expect(rawCapture.candidateId).toBe(row.candidateId);
  expect(rawCapture.contractSha256).toBe(row.capturedContractSha256);
  const production = evidence.productionConformance as Record<string, unknown> | undefined;
  if (production !== undefined) {
    expect(production.contractSha256).toBe(row.capturedContractSha256);
    expect(production.candidateId).toBe(row.candidateId);
  }
  if (evidence.verdict !== undefined) {
    expect(evidence.verdict).toBe('OMIT');
  }
}

function executeOmitNotApplicable(row: ProviderReplayRow): void {
  validateCapturedEvidence(row);
  if (row.candidateSource !== undefined) {
    expect(existsSync(resolveRepoPath(row.candidateSource))).toBe(false);
  }
  if (row.candidateTest !== undefined) {
    expect(existsSync(resolveRepoPath(row.candidateTest))).toBe(false);
  }
  if (row.omitFromCatalog) {
    assertCatalogAbsent(row.candidateId);
  } else {
    expect(API_PROVIDER_CATALOG).toHaveProperty(row.candidateId);
    expect(KNOWN_PROVIDERS).toHaveProperty(row.candidateId);
    const pickerIds = assemblePickerDescriptors()
      .filter((entry) => entry.kind === 'api')
      .map((entry) => entry.descriptor.id);
    expect(pickerIds).toContain(row.candidateId);
  }
}

async function loadCandidateModule(modulePath: string): Promise<UnregisteredProviderCandidate> {
  const moduleValue: unknown = await import(pathToFileURL(modulePath).href);
  if (!moduleValue || typeof moduleValue !== 'object') {
    throw new Error(`candidate module ${modulePath} did not load as an object`);
  }
  for (const [name, value] of Object.entries(moduleValue as Record<string, unknown>)) {
    if (name === '__esModule') continue;
    const parsed = UnregisteredProviderCandidate.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  throw new Error(`candidate module ${modulePath} did not export a provider candidate`);
}

async function replayPassEvidence(row: ProviderReplayRow): Promise<void> {
  const evidence = CandidateEvidence.parse(readEvidenceJson(row.evidencePath));
  expect(evidence.verdict).toBe('PASS');
  expect(evidence.productionConformance).not.toBeNull();
  if (evidence.productionConformance === null) {
    throw new Error('PASS evidence requires productionConformance');
  }
  assertCapturedProductionShape(evidence.productionConformance.stdout);

  if (row.candidateSource === undefined) {
    throw new Error(`PASS replay requires candidate source for ${row.candidateId}`);
  }
  expect(existsSync(resolveRepoPath(row.candidateSource))).toBe(true);
  if (row.candidateTest !== undefined) {
    expect(existsSync(resolveRepoPath(row.candidateTest))).toBe(true);
  }
  expect(API_PROVIDER_CATALOG).toHaveProperty(row.candidateId);
  expect(KNOWN_PROVIDERS).toHaveProperty(row.candidateId);

  const credential = `replay-credential-${row.candidateId}-canary`;
  const envName = credentialEnvForContract(row.contract);
  const environment: Record<string, string> = { [envName]: credential };
  if (row.contract.endpointPolicy.kind === 'allowed-https') {
    environment[`${row.candidateId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_BASE_URL`] =
      'https://token-plan-cn.xiaomimimo.com/v1';
  }
  if (row.candidateId === 'dashscope') {
    environment.DASHSCOPE_BASE_URL =
      'https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  }

  const fake = fakeFetchForContract(row.contract);
  const candidate = await loadCandidateModule(row.candidateSource);
  assertClosedPolicySurface(candidate.policy);

  const unregistered = createUnregisteredOpenAICompatProvider(candidate, {
    environment,
    fetchImplementation: fake.fetchImplementation,
  });
  expect(unregistered.name).toBe(row.candidateId);
  const models = await unregistered.listModels();
  expect(models.length).toBeGreaterThan(0);

  const directory = await temporaryDirectory();
  const recordPath = join(directory, `${row.candidateId}.json`);
  await writeFile(recordPath, `${JSON.stringify({ rawCapture: evidence.rawCapture }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const productionOutcome = await runProductionProviderConformance({
    modulePath: resolveRepoPath(row.candidateSource),
    recordPath,
    environment,
    fetchImplementation: fake.fetchImplementation,
  });
  expect(productionOutcome.exitCode).toBe(PROVIDER_CONFORMANCE_EXIT_CODES.PASS);
  const replayEvidence = JSON.parse(await readFile(recordPath, 'utf8')) as {
    productionConformance: { stdout: string };
  };
  assertCapturedProductionShape(replayEvidence.productionConformance.stdout);
  const replayed = parseProductionStdout(replayEvidence.productionConformance.stdout);
  const captured = parseProductionStdout(evidence.productionConformance.stdout);
  expect(replayed.status).toBe(captured.status);
  expect(replayed.terminal).toBe(captured.terminal);
  expect(replayed.cancellationProbe).toBe(captured.cancellationProbe);

  const completionRequest = fake.requests.find((request) =>
    request.url.includes('/chat/completions'),
  );
  if (completionRequest === undefined) {
    throw new Error('expected a completion request during unregistered replay');
  }
  assertProductionReplayCapturesPolicy(candidate.policy, completionRequest.body);

  const registered = getProvider(row.candidateId, {
    apiKey: credential,
    apiBase:
      row.contract.endpointPolicy.kind === 'fixed-origin'
        ? row.contract.endpointPolicy.baseURL
        : (environment.DASHSCOPE_BASE_URL ?? fake.endpoint),
  });
  expect(registered.name).toBe(row.candidateId);
  const registeredFake = fakeFetchForContract(row.contract);
  const registeredProvider = createUnregisteredOpenAICompatProvider(candidate, {
    environment,
    fetchImplementation: registeredFake.fetchImplementation,
  });
  const registeredModels = await registeredProvider.listModels();
  expect(registeredModels.length).toBeGreaterThan(0);
}

describe('provider conformance replay', () => {
  it('defines one replay row per T-044–T-053 verdict candidate', () => {
    expect(REPLAY_ROWS).toHaveLength(10);
    expect(REPLAY_ROWS.map((row) => row.taskId).toSorted()).toEqual(
      [
        'T-044',
        'T-045',
        'T-046',
        'T-047',
        'T-048',
        'T-049',
        'T-050',
        'T-051',
        'T-052',
        'T-053',
      ].toSorted(),
    );
    const candidateIds = REPLAY_ROWS.map((row) => row.candidateId);
    expect(candidateIds).toEqual([
      'mistral',
      'gemini',
      'cerebras',
      'zai',
      'mimo',
      'mimo-token-plan',
      'minimax',
      'moonshot',
      'dashscope',
      'llama-cpp',
    ]);
  });

  it('fails when OpenAICompatPolicy grows without updating replay capture', () => {
    for (const row of REPLAY_ROWS) {
      assertClosedPolicySurface(
        resolveOpenAICompatPolicy({
          provider: row.candidateId,
          model: row.contract.modelIds[0],
        }),
      );
    }
  });

  it.each(REPLAY_ROWS)(
    '$taskId replays PASS evidence or executes OMIT-NOT-APPLICABLE without network',
    async (row) => {
      vi.stubGlobal('fetch', vi.fn());
      if (isPassCandidateId(row)) {
        await replayPassEvidence(row);
      } else {
        executeOmitNotApplicable(row);
      }
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    },
  );

  it('gives every T-044–T-053 verdict row its own evidence fixture on disk', () => {
    const evidencePaths = REPLAY_ROWS.map((row) => row.evidencePath);
    expect(new Set(evidencePaths).size).toBe(evidencePaths.length);
    for (const evidencePath of evidencePaths) {
      expect(existsSync(resolveRepoPath(evidencePath))).toBe(true);
    }
  });
});
