import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_CONFORMANCE_EXIT_CODES } from './conformance.js';
import { runProductionProviderConformance } from './conformance-production.js';
import { runRawProviderConformance } from './conformance-raw.js';
import { createUnregisteredOpenAICompatProvider } from './unregistered-provider.js';
import { contractSha256 } from './candidate-contract.js';

const credential = 'ex-live-credential-canary-123';

const contract = {
  id: 'example-provider',
  service: 'example',
  offering: 'payg' as const,
  roles: ['implementer'] as const,
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
    max: 8192,
  },
  expectedRawTerminal: 'finish_reason',
  asOf: '2026-07-31',
};

const policy = {
  tokenField: 'max_tokens' as const,
  streamUsage: true,
  temperature: 'verbatim' as const,
  effort: 'omit' as const,
  reasoning: 'omit' as const,
  extraBody: undefined,
  finishReasons: ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'] as const,
};

const candidate = {
  rawContract: contract,
  descriptor: {
    id: contract.id,
    service: contract.service,
    offering: contract.offering,
    roles: contract.roles,
    endpointPolicy: contract.endpointPolicy,
    credentialEnv: contract.credentialEnv,
    credentialPrefix: contract.credentialPrefix,
    billing: 'api-metered' as const,
    compatibility: 'unverified' as const,
    dataUse: 'no-training' as const,
    privacyURL: 'https://example.test/privacy',
    termsURL: 'https://example.test/terms',
    asOf: contract.asOf,
  },
  knownModels: [{ name: 'example-model', isDefault: true }],
  policy,
};

const streamBody = [
  'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"done"},"finish_reason":null}],"usage":null}\n\n',
  'data: {"id":"chatcmpl-test","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n',
  'data: [DONE]\n\n',
].join('');

const MAX_EVIDENCE_BYTES = 32_768;

// A model list far past the evidence budget whose truncation offset falls inside a
// multi-byte character, and a stream whose declared terminal only appears past the budget.
const oversizedModelList = JSON.stringify({
  data: [{ id: 'example-model' }, { id: '長'.repeat(12_000) }],
});
const oversizedStreamBody = [
  `data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"${'令'.repeat(20_000)}"}}]}\n\n`,
  'data: {"id":"chatcmpl-test","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n',
  'data: [DONE]\n\n',
].join('');

const responseHeaders = { 'content-type': 'application/json' };

function response(body: string, status = 200, headers = responseHeaders): Response {
  return new Response(body, { status, headers });
}

function fakeFetch(
  options: {
    readonly completionStatus?: number;
    readonly modelsBody?: string;
    readonly completionBody?: string;
  } = {},
) {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const fetchImplementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = request.method === 'POST' ? await request.text() : '';
    requests.push({ url: request.url, method: request.method, body });
    if (request.url.endsWith('/models')) {
      return response(options.modelsBody ?? JSON.stringify({ data: [{ id: 'example-model' }] }));
    }
    if (request.url.endsWith('/chat/completions')) {
      if (options.completionStatus !== undefined) {
        return response('upstream failure', options.completionStatus);
      }
      return response(options.completionBody ?? streamBody, 200, {
        'content-type': 'text/event-stream',
      });
    }
    return response('not found', 404);
  };
  return { fetchImplementation, requests };
}

const tempDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'splitbrief-provider-conformance-'));
  tempDirectories.push(directory);
  return directory;
}

async function writeCandidateModule(directory: string, value: unknown): Promise<string> {
  const path = join(directory, 'candidate.mjs');
  await writeFile(path, `export const CANDIDATE = ${JSON.stringify(value)};\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return path;
}

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

describe('provider conformance harness', () => {
  it('captures raw evidence before any candidate module exists and never admits it', async () => {
    const directory = await temporaryDirectory();
    const recordPath = join(directory, 'evidence.json');
    const fake = fakeFetch();
    const outcome = await runRawProviderConformance({
      contractJson: JSON.stringify(contract),
      recordPath,
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: fake.fetchImplementation,
    });

    expect(outcome.exitCode).toBe(PROVIDER_CONFORMANCE_EXIT_CODES.PASS);
    const evidence = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(evidence)).toEqual(['rawCapture']);
    expect(evidence).not.toHaveProperty('verdict');
    expect(JSON.stringify(evidence)).not.toContain(credential);
    expect(fake.requests.map((request) => request.url)).toEqual([
      'https://api.example.test/v1/models',
      'https://api.example.test/v1/chat/completions',
    ]);
  });

  it('judges the full model list and still bounds the recorded evidence', async () => {
    const directory = await temporaryDirectory();
    const recordPath = join(directory, 'evidence.json');
    const fake = fakeFetch({ modelsBody: oversizedModelList });
    const outcome = await runRawProviderConformance({
      contractJson: JSON.stringify(contract),
      recordPath,
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: fake.fetchImplementation,
    });

    expect(Buffer.byteLength(oversizedModelList, 'utf8')).toBeGreaterThan(MAX_EVIDENCE_BYTES);
    expect(outcome.exitCode).toBe(PROVIDER_CONFORMANCE_EXIT_CODES.PASS);
    const { rawCapture } = JSON.parse(await readFile(recordPath, 'utf8')) as {
      rawCapture: { stdout: string };
    };
    expect(Buffer.byteLength(rawCapture.stdout, 'utf8')).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
    expect([...rawCapture.stdout].some((char) => char.codePointAt(0) === 0xfffd)).toBe(false);
  });

  it('detects a declared terminal that arrives past the evidence budget', async () => {
    const directory = await temporaryDirectory();
    const recordPath = join(directory, 'evidence.json');
    const fake = fakeFetch({ completionBody: oversizedStreamBody });
    const outcome = await runRawProviderConformance({
      contractJson: JSON.stringify(contract),
      recordPath,
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: fake.fetchImplementation,
    });

    const budgetedPrefix = Buffer.from(oversizedStreamBody, 'utf8')
      .subarray(0, MAX_EVIDENCE_BYTES)
      .toString('utf8');
    expect(budgetedPrefix).not.toContain('finish_reason');
    expect(outcome.exitCode).toBe(PROVIDER_CONFORMANCE_EXIT_CODES.PASS);
    const { rawCapture } = JSON.parse(await readFile(recordPath, 'utf8')) as {
      rawCapture: { stdout: string };
    };
    expect(Buffer.byteLength(rawCapture.stdout, 'utf8')).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
  });

  it('omits missing or wrong-family credentials without making a request', async () => {
    const directory = await temporaryDirectory();
    const fake = fakeFetch();
    const missing = await runRawProviderConformance({
      contractJson: JSON.stringify(contract),
      recordPath: join(directory, 'missing.json'),
      environment: {},
      fetchImplementation: fake.fetchImplementation,
    });
    const wrong = await runRawProviderConformance({
      contractJson: JSON.stringify(contract),
      recordPath: join(directory, 'wrong.json'),
      environment: { EXAMPLE_API_KEY: 'wrong-family' },
      fetchImplementation: fake.fetchImplementation,
    });

    expect(missing.exitCode).toBe(PROVIDER_CONFORMANCE_EXIT_CODES.OMIT);
    expect(wrong.exitCode).toBe(PROVIDER_CONFORMANCE_EXIT_CODES.OMIT);
    expect(fake.requests).toHaveLength(0);
    expect(
      JSON.stringify(JSON.parse(await readFile(join(directory, 'missing.json'), 'utf8'))),
    ).not.toContain(credential);
  });

  it('constructs an unregistered provider through the shared client and transport', async () => {
    const fake = fakeFetch();
    const provider = createUnregisteredOpenAICompatProvider(candidate, {
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: fake.fetchImplementation,
    });
    expect(provider.name).toBe('example-provider');
    expect(provider.baseURL).toBe('https://api.example.test/v1');
    expect(provider.apiKey()).toBe(credential);
    expect(await provider.listModels()).toEqual(['example-model']);
    expect(fake.requests).toHaveLength(1);
  });

  it('runs production conformance against the same evidence and records PASS', async () => {
    const directory = await temporaryDirectory();
    const recordPath = join(directory, 'evidence.json');
    const rawFake = fakeFetch();
    await runRawProviderConformance({
      contractJson: JSON.stringify(contract),
      recordPath,
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: rawFake.fetchImplementation,
    });
    const modulePath = await writeCandidateModule(directory, candidate);
    const productionFake = fakeFetch();
    const outcome = await runProductionProviderConformance({
      modulePath,
      recordPath,
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: productionFake.fetchImplementation,
    });

    expect(outcome.exitCode).toBe(PROVIDER_CONFORMANCE_EXIT_CODES.PASS);
    const evidence = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    expect(evidence).toHaveProperty('verdict', 'PASS');
    expect(evidence).toHaveProperty('productionConformance');
    expect(JSON.stringify(evidence)).not.toContain(credential);
    expect(productionFake.requests.map((request) => request.url)).toEqual([
      'https://api.example.test/v1/models',
      'https://api.example.test/v1/chat/completions',
    ]);
  });

  it('records an upstream production failure as OMIT and never promotes a provider', async () => {
    const directory = await temporaryDirectory();
    const recordPath = join(directory, 'evidence.json');
    const rawFake = fakeFetch();
    await runRawProviderConformance({
      contractJson: JSON.stringify(contract),
      recordPath,
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: rawFake.fetchImplementation,
    });
    const modulePath = await writeCandidateModule(directory, candidate);
    const outcome = await runProductionProviderConformance({
      modulePath,
      recordPath,
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: fakeFetch({ completionStatus: 503 }).fetchImplementation,
    });
    const evidence = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;

    expect(outcome.exitCode).toBe(PROVIDER_CONFORMANCE_EXIT_CODES.OMIT);
    expect(evidence).toHaveProperty('verdict', 'OMIT');
    expect(JSON.stringify(evidence)).not.toContain(credential);
  });

  it('rejects raw/production identity mismatches as harness failures', async () => {
    const directory = await temporaryDirectory();
    const recordPath = join(directory, 'evidence.json');
    const fake = fakeFetch();
    await runRawProviderConformance({
      contractJson: JSON.stringify(contract),
      recordPath,
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: fake.fetchImplementation,
    });
    const changedCandidate = {
      ...candidate,
      rawContract: { ...contract, modelIds: ['different-model'] },
    };
    const modulePath = await writeCandidateModule(directory, changedCandidate);
    const outcome = await runProductionProviderConformance({
      modulePath,
      recordPath,
      environment: { EXAMPLE_API_KEY: credential },
      fetchImplementation: fake.fetchImplementation,
    });
    expect(outcome.exitCode).toBe(PROVIDER_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE);
    expect(contractSha256(contract)).not.toBe(contractSha256(changedCandidate.rawContract));
  });
});
