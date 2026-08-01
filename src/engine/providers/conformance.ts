import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type OpenAI from 'openai';
import type { z } from 'zod';
import type { EndpointPolicyFetchOwner } from '../../core/providers/endpoint-policy.js';
import {
  endpointPolicyError,
  normalizeProviderEndpoint,
  endpointPolicyFetch,
} from '../../core/providers/endpoint-policy.js';
import {
  createEndpointPolicyFetch,
  type EndpointPolicyFetch,
} from '../../lib/http/policy-fetch.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import {
  CandidateEvidence,
  CONFORMANCE_EXIT_CODES,
  CONFORMANCE_PROMPT,
  MAX_EVIDENCE_OUTPUT_BYTES,
  RawProviderCandidateContract,
  UnregisteredProviderCandidate,
  baseUrlEnvironmentName,
  contractSha256,
  normalizeCandidateEvidence,
  sanitizeCandidateOutput,
} from './candidate-contract.js';
import type { OpenAICompatPolicy } from './openai-compat-policy.js';
import { createClientFromProvider } from './client/connection.js';
import {
  extractOpenAIModelList,
  fetchModelList,
  isOpenAIModelList,
  sanitizeProviderDiagnostic,
  type ProviderDiagnosticOptions,
} from './client/request.js';
import type { ProviderDefWithMetadata } from './types.js';
import { toStreamClient } from './openai-stream/client.js';
import type { StreamClient } from './openai-stream/request.js';
import { streamCompletion } from './openai-stream/completion.js';
import type { RunnerCallResult } from '../calls/types.js';
import { isRecord } from '../../utils/type-guards.js';
import { error as createError } from '../../utils/error.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MODEL_LIST_TIMEOUT_MS = 5_000;
const COMPLETION_TIMEOUT_MS = 30_000;

export const PROVIDER_CONFORMANCE_EXIT_CODES = CONFORMANCE_EXIT_CODES;

export type ProviderConformanceExitCode =
  (typeof PROVIDER_CONFORMANCE_EXIT_CODES)[keyof typeof PROVIDER_CONFORMANCE_EXIT_CODES];
export type ProviderConformanceVerdict = 'PASS' | 'OMIT';

export interface ProviderConformanceEnvironment {
  readonly [name: string]: string | undefined;
}

export interface ProviderConformanceFetchOptions {
  readonly fetchImplementation?: EndpointPolicyFetch | undefined;
  readonly environment?: ProviderConformanceEnvironment | undefined;
}

export interface ProviderConformanceOutcome {
  readonly exitCode: ProviderConformanceExitCode;
  readonly verdict: ProviderConformanceVerdict;
  readonly candidateId?: string;
  readonly role?: ConformanceRole;
  readonly reason?: string;
}

type ConformanceRole = 'planner' | 'implementer';

export interface RawProviderConformanceOptions extends ProviderConformanceFetchOptions {
  readonly contractJson: string;
  readonly recordPath: string;
}

export interface ProductionProviderConformanceOptions extends ProviderConformanceFetchOptions {
  readonly modulePath: string;
  readonly recordPath: string;
}

export interface UnregisteredOpenAICompatProvider
  extends ProviderDefWithMetadata,
    EndpointPolicyFetchOwner {
  readonly candidate: UnregisteredProviderCandidateValue;
  readonly policy: OpenAICompatPolicy;
  readonly client: OpenAI;
  readonly streamClient: StreamClient;
}

type UnregisteredProviderCandidateValue = z.infer<typeof UnregisteredProviderCandidate>;

type RawCapture = z.infer<typeof CandidateEvidence>['rawCapture'];

interface ProbeResult {
  readonly status: number;
  // `text` is the full response and decides the verdict; `evidence` is the bounded,
  // redacted copy that is the only part written to the record.
  readonly text: string;
  readonly evidence: string;
  readonly body: unknown;
}

type ConformanceErrorCode = 'credentialed-omit' | 'harness-failure';

function conformanceError(code: ConformanceErrorCode, message: string): Error {
  return createError(code, message);
}

function hasConformanceCode(value: unknown, code: ConformanceErrorCode): boolean {
  return isRecord(value) && value.kind === code;
}

function throwConformance(code: ConformanceErrorCode, message: string): never {
  throw conformanceError(code, message);
}

function environmentOf(options: ProviderConformanceFetchOptions): ProviderConformanceEnvironment {
  return options.environment ?? process.env;
}

function redactWithCredentials(value: string, credentialValues: readonly string[]): string {
  let sanitized = value;
  for (const credential of credentialValues) {
    if (credential.length === 0) continue;
    sanitized = sanitized.replaceAll(credential, '[REDACTED]');
  }
  return boundedCandidateOutput(sanitized);
}

function boundedCandidateOutput(value: string): string {
  return sanitizeCandidateOutput(value, MAX_EVIDENCE_OUTPUT_BYTES);
}

function diagnosticOptions(credentials: readonly string[]): ProviderDiagnosticOptions {
  return credentials.length === 0 ? {} : { credentialValues: credentials };
}

function safeDiagnostic(error: unknown, credentials: readonly string[]): string {
  return redactWithCredentials(
    sanitizeProviderDiagnostic(error, diagnosticOptions(credentials)),
    credentials,
  );
}

function roleForContract(contract: RawProviderCandidateContract): ConformanceRole {
  const [role] = contract.roles;
  if (role === undefined) throwConformance('harness-failure', 'provider contract has no role');
  return role;
}

function credentialForContract(
  contract: RawProviderCandidateContract,
  environment: ProviderConformanceEnvironment,
): string {
  if (contract.offering === 'local' && contract.credentialEnv === null) return '';
  const envName = contract.credentialEnv;
  if (envName === undefined || envName === null) {
    throwConformance('harness-failure', 'remote provider contract has no credential environment');
  }
  const value = environment[envName] ?? '';
  if (value.length === 0 && contract.offering === 'local') return '';
  if (value.length === 0)
    throwConformance('credentialed-omit', `missing credential for ${envName}`);
  if (contract.credentialPrefix !== null && contract.credentialPrefix !== undefined) {
    if (!value.startsWith(contract.credentialPrefix)) {
      throwConformance('credentialed-omit', 'credential family does not match the declared prefix');
    }
  }
  return value;
}

function endpointForContract(
  contract: RawProviderCandidateContract,
  environment: ProviderConformanceEnvironment,
): string {
  const requested =
    contract.endpointPolicy.kind === 'allowed-https'
      ? (environment[baseUrlEnvironmentName(contract.id)] ?? '')
      : contract.endpointPolicy.kind === 'fixed-origin'
        ? contract.endpointPolicy.baseURL
        : contract.endpointPolicy.defaultBaseURL;
  if (requested.length === 0)
    throwConformance('credentialed-omit', 'missing configured provider endpoint');
  try {
    return normalizeProviderEndpoint(contract.endpointPolicy, requested);
  } catch (error) {
    throwConformance(
      'harness-failure',
      `declared endpoint is invalid: ${safeDiagnostic(error, [])}`,
    );
  }
}

function bearerHeaders(credential: string): Record<string, string> | undefined {
  return credential.length === 0 ? undefined : { Authorization: `Bearer ${credential}` };
}

async function readResponseText(response: Response): Promise<string> {
  if (response.body === null) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= MAX_RESPONSE_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (total > MAX_RESPONSE_BYTES) {
    throwConformance('credentialed-omit', 'provider response exceeded the conformance read budget');
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function captureRequest(
  fetchImplementation: EndpointPolicyFetch,
  endpoint: string,
  path: string,
  init: RequestInit,
  credentials: readonly string[],
): Promise<ProbeResult> {
  const url = `${endpoint}${path}`;
  const response = await fetchImplementation(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
  });
  const text = await readResponseText(response);
  return {
    status: response.status,
    text,
    evidence: redactWithCredentials(text, credentials),
    body: parseJsonBody(text),
  };
}

function rawRequestBody(
  contract: RawProviderCandidateContract,
  model: string,
): Record<string, unknown> {
  const request = contract.rawRequest;
  const token = { [request.tokenField]: request.max };
  return {
    model,
    messages: [{ role: 'user', content: CONFORMANCE_PROMPT }],
    stream: request.stream,
    ...(request.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...token,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.effort === undefined || request.effort === 'omit'
      ? {}
      : { effort: request.effort }),
    ...(request.reasoning === undefined || request.reasoning === 'omit'
      ? {}
      : { reasoning_effort: request.reasoning }),
    ...(request.extraBody ?? {}),
  };
}

function chooseModel(
  contract: RawProviderCandidateContract,
  knownModels: readonly CandidateKnownModel[],
  discovered: readonly string[],
): string {
  const requested = contract.modelIds[0];
  if (requested !== undefined) return requested;
  const defaultModel = knownModels.find((model) => model.isDefault)?.name;
  return (
    defaultModel ??
    discovered[0] ??
    (() => {
      throwConformance('credentialed-omit', 'provider did not return a model for live discovery');
    })()
  );
}

type CandidateKnownModel = UnregisteredProviderCandidateValue['knownModels'][number];

function modelListIsValid(contract: RawProviderCandidateContract, body: unknown): string[] {
  if (!isOpenAIModelList(body))
    throwConformance('credentialed-omit', 'provider returned a malformed model list');
  const models = extractOpenAIModelList(body, (item) => item.id);
  if (models.length === 0) throwConformance('credentialed-omit', 'provider returned no models');
  for (const requested of contract.modelIds) {
    if (!models.includes(requested)) {
      throwConformance(
        'credentialed-omit',
        `declared model ${requested} was not present in the live model list`,
      );
    }
  }
  return models;
}

function evidenceCapture(
  contract: RawProviderCandidateContract,
  output: string,
  errorText: string,
): RawCapture {
  const role = roleForContract(contract);
  return {
    candidateId: contract.id,
    role,
    contractSha256: contractSha256(contract),
    stdout: boundedCandidateOutput(output),
    stderr: boundedCandidateOutput(errorText),
  };
}

async function writeRawRecord(recordPath: string, rawCapture: RawCapture): Promise<void> {
  const record = JSON.stringify({ rawCapture }, null, 2);
  await mkdir(dirname(resolve(recordPath)), { recursive: true });
  await writeFile(recordPath, `${record}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeProductionRecord(
  recordPath: string,
  rawCapture: RawCapture,
  production: RawCapture | null,
  verdict: ProviderConformanceVerdict,
): Promise<void> {
  const evidence = normalizeCandidateEvidence({
    rawCapture,
    productionConformance: production,
    verdict,
  });
  await mkdir(dirname(resolve(recordPath)), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function runRawProviderConformance(
  options: RawProviderConformanceOptions,
): Promise<ProviderConformanceOutcome> {
  let contract: RawProviderCandidateContract;
  try {
    const parsed: unknown = JSON.parse(options.contractJson);
    contract = RawProviderCandidateContract.parse(parsed);
  } catch (error) {
    return {
      exitCode: PROVIDER_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
      verdict: 'OMIT',
      reason: `invalid provider contract: ${safeDiagnostic(error, [])}`,
    };
  }

  const role = roleForContract(contract);
  const credentials: string[] = [];
  let output = '';
  let errorText = '';
  try {
    const endpoint = endpointForContract(contract, environmentOf(options));
    const credential = credentialForContract(contract, environmentOf(options));
    if (credential.length > 0) credentials.push(credential);
    const policyFetch = createEndpointPolicyFetch(
      endpoint,
      endpointPolicyError.invalid,
      options.fetchImplementation ?? globalThis.fetch,
    );
    const headers = bearerHeaders(credential);
    const modelResult = await captureRequest(
      policyFetch,
      endpoint,
      '/models',
      { method: 'GET', ...(headers ? { headers } : {}) },
      credentials,
    );
    output += `models status=${modelResult.status}\n${modelResult.evidence}\n`;
    if (modelResult.status < 200 || modelResult.status >= 300) {
      throwConformance(
        'credentialed-omit',
        `provider model list returned HTTP ${modelResult.status}`,
      );
    }
    const models = modelListIsValid(contract, modelResult.body);
    const model = chooseModel(contract, [], models);
    const completionResult = await captureRequest(
      policyFetch,
      endpoint,
      '/chat/completions',
      {
        method: 'POST',
        ...(headers
          ? { headers: { ...headers, 'content-type': 'application/json' } }
          : { headers: { 'content-type': 'application/json' } }),
        body: JSON.stringify(rawRequestBody(contract, model)),
        signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      },
      credentials,
    );
    output += `completion status=${completionResult.status}\n${completionResult.evidence}\n`;
    if (!completionResult.body && completionResult.text.length === 0) {
      throwConformance('credentialed-omit', 'provider returned an empty completion response');
    }
    if (completionResult.status < 200 || completionResult.status >= 300) {
      throwConformance(
        'credentialed-omit',
        `provider completion returned HTTP ${completionResult.status}`,
      );
    }
    if (!completionResult.text.includes(contract.expectedRawTerminal)) {
      throwConformance(
        'credentialed-omit',
        'provider completion did not expose the declared terminal field',
      );
    }
    await writeRawRecord(options.recordPath, evidenceCapture(contract, output, errorText));
    return {
      exitCode: PROVIDER_CONFORMANCE_EXIT_CODES.PASS,
      verdict: 'PASS',
      candidateId: contract.id,
      role,
    };
  } catch (error) {
    const isHarness = hasConformanceCode(error, 'harness-failure');
    const reason = safeDiagnostic(error, credentials);
    errorText = reason;
    output += `raw conformance ${isHarness ? 'harness failure' : 'omitted'}\n`;
    await writeRawRecord(options.recordPath, evidenceCapture(contract, output, errorText));
    return {
      exitCode: isHarness
        ? PROVIDER_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE
        : PROVIDER_CONFORMANCE_EXIT_CODES.OMIT,
      verdict: 'OMIT',
      candidateId: contract.id,
      role,
      reason,
    };
  }
}

function candidateFromModule(
  moduleValue: Record<string, unknown>,
): UnregisteredProviderCandidateValue {
  const candidates: UnregisteredProviderCandidateValue[] = [];
  for (const [name, value] of Object.entries(moduleValue)) {
    if (name === '__esModule') continue;
    const parsed = UnregisteredProviderCandidate.safeParse(value);
    if (parsed.success) candidates.push(parsed.data);
  }
  if (candidates.length !== 1) {
    throwConformance(
      'harness-failure',
      'candidate module must export exactly one valid provider candidate',
    );
  }
  const [candidate] = candidates;
  if (candidate === undefined)
    throwConformance('harness-failure', 'candidate module did not export a candidate');
  return candidate;
}

async function loadCandidate(modulePath: string): Promise<UnregisteredProviderCandidateValue> {
  const resolvedPath = isAbsolute(modulePath) ? modulePath : resolve(modulePath);
  const moduleValue: unknown = await import(pathToFileURL(resolvedPath).href);
  if (!isRecord(moduleValue)) {
    throwConformance('harness-failure', 'candidate module did not load as an object');
  }
  return candidateFromModule(moduleValue);
}

function endpointForCandidate(
  candidate: UnregisteredProviderCandidateValue,
  environment: ProviderConformanceEnvironment,
): string {
  return endpointForContract(candidate.rawContract, environment);
}

function createProviderHeaders(credential: string): Record<string, string> | undefined {
  return bearerHeaders(credential);
}

export function createUnregisteredOpenAICompatProvider(
  candidate: UnregisteredProviderCandidateValue,
  options: ProviderConformanceFetchOptions = {},
): UnregisteredOpenAICompatProvider {
  const environment = environmentOf(options);
  const endpoint = endpointForCandidate(candidate, environment);
  const credential = credentialForContract(candidate.rawContract, environment);
  const policyFetch = createEndpointPolicyFetch(
    endpoint,
    endpointPolicyError.invalid,
    options.fetchImplementation ?? globalThis.fetch,
  );
  const provider: ProviderDefWithMetadata & EndpointPolicyFetchOwner = {
    [endpointPolicyFetch]: policyFetch,
    name: candidate.descriptor.id,
    baseURL: endpoint,
    apiKey: () => credential,
    isLocal: candidate.rawContract.offering === 'local',
    listModels: async () => {
      const headers = createProviderHeaders(credential);
      return fetchModelList({
        endpoint: `${endpoint}/models`,
        ...(headers ? { headers } : {}),
        fetch: policyFetch,
        extractModels: (body) => {
          if (!isOpenAIModelList(body)) return null;
          return extractOpenAIModelList(body, (item) => item.id);
        },
      });
    },
    listModelsWithMetadata: async (): Promise<DetectedModel[]> => {
      const ids = await provider.listModels();
      return ids.map((id) => ({ id }));
    },
    detectContextLength: async (model: string): Promise<number | null> => {
      const known = candidate.knownModels.find(
        (entry) => entry.name === model || entry.aliases?.includes(model),
      );
      return known?.contextLength ?? null;
    },
  };
  const client = createClientFromProvider(provider);
  return {
    ...provider,
    candidate,
    policy: candidate.policy,
    client,
    streamClient: toStreamClient(client),
  };
}

async function runProductionProbe(
  candidate: UnregisteredProviderCandidateValue,
  provider: UnregisteredOpenAICompatProvider,
): Promise<{ readonly result: RunnerCallResult; readonly model: string }> {
  const discovered = await provider.listModels();
  const model = chooseModel(candidate.rawContract, candidate.knownModels, discovered);
  const expectedModels = candidate.rawContract.modelIds;
  for (const expected of expectedModels) {
    if (!discovered.includes(expected)) {
      throwConformance(
        'credentialed-omit',
        `declared model ${expected} is absent from the live model list`,
      );
    }
  }
  const result = await streamCompletion(
    provider.streamClient,
    model,
    [{ role: 'user', content: CONFORMANCE_PROMPT }],
    {
      temperature: 0.2,
      maxTokens: candidate.rawContract.rawRequest.max,
      onProgress: () => undefined,
      signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      endpoint: {
        provider: candidate.descriptor.id,
        apiBase: provider.baseURL,
        policy: candidate.policy,
      },
      policy: candidate.policy,
      credentialValues: provider.apiKey() ? [provider.apiKey()] : [],
    },
  );
  if (result.status !== 'completed' && result.status !== 'truncated') {
    throwConformance('credentialed-omit', `provider completion ended with ${result.status}`);
  }
  const cancellation = new AbortController();
  cancellation.abort();
  try {
    await streamCompletion(
      provider.streamClient,
      model,
      [{ role: 'user', content: 'Cancellation probe.' }],
      {
        temperature: 0.2,
        maxTokens: 1,
        onProgress: () => undefined,
        signal: cancellation.signal,
        endpoint: {
          provider: candidate.descriptor.id,
          apiBase: provider.baseURL,
          policy: candidate.policy,
        },
        policy: candidate.policy,
        credentialValues: provider.apiKey() ? [provider.apiKey()] : [],
      },
    );
    throwConformance('credentialed-omit', 'provider ignored an already-aborted request');
  } catch (error) {
    if (hasConformanceCode(error, 'credentialed-omit')) throw error;
  }
  return { result, model };
}

function productionOutput(
  candidate: UnregisteredProviderCandidateValue,
  model: string,
  result: RunnerCallResult,
): string {
  return JSON.stringify(
    {
      candidate: candidate.descriptor.id,
      model,
      status: result.status,
      textBytes: Buffer.byteLength(result.text, 'utf8'),
      usage: result.usage,
      terminal: result.status === 'completed' || result.status === 'truncated',
      cancellationProbe: 'pre-aborted-signal-tested-by-shared-stream',
      redirectPolicy: 'same-origin-only',
      errorDiagnostics: 'sanitized',
    },
    null,
    2,
  );
}

async function readRawRecord(recordPath: string): Promise<RawCapture> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(recordPath, 'utf8'));
  } catch {
    throwConformance('harness-failure', 'provider evidence record is missing or invalid JSON');
  }
  if (!isRecord(parsed) || !('rawCapture' in parsed)) {
    throwConformance('harness-failure', 'provider evidence record has no rawCapture');
  }
  const candidateEvidence = CandidateEvidence.safeParse({
    rawCapture: parsed.rawCapture,
    productionConformance: null,
    verdict: 'OMIT',
  });
  if (!candidateEvidence.success)
    throwConformance('harness-failure', 'provider rawCapture is invalid');
  return candidateEvidence.data.rawCapture;
}

export async function runProductionProviderConformance(
  options: ProductionProviderConformanceOptions,
): Promise<ProviderConformanceOutcome> {
  let rawCapture: RawCapture;
  try {
    rawCapture = await readRawRecord(options.recordPath);
  } catch (error) {
    return {
      exitCode: PROVIDER_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
      verdict: 'OMIT',
      reason: safeDiagnostic(error, []),
    };
  }

  let candidate: UnregisteredProviderCandidateValue;
  try {
    candidate = await loadCandidate(options.modulePath);
  } catch (error) {
    return {
      exitCode: PROVIDER_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
      verdict: 'OMIT',
      candidateId: rawCapture.candidateId,
      role: rawCapture.role,
      reason: safeDiagnostic(error, []),
    };
  }

  const expectedHash = contractSha256(candidate.rawContract);
  if (
    rawCapture.candidateId !== candidate.rawContract.id ||
    rawCapture.contractSha256 !== expectedHash ||
    rawCapture.role !== roleForContract(candidate.rawContract)
  ) {
    return {
      exitCode: PROVIDER_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
      verdict: 'OMIT',
      candidateId: candidate.rawContract.id,
      role: roleForContract(candidate.rawContract),
      reason: 'raw evidence identity does not match the candidate contract',
    };
  }

  const credentials = [];
  try {
    const provider = createUnregisteredOpenAICompatProvider(candidate, options);
    const credential = provider.apiKey();
    if (credential.length > 0) credentials.push(credential);
    const { result, model } = await runProductionProbe(candidate, provider);
    const productionCapture = {
      candidateId: candidate.rawContract.id,
      role: roleForContract(candidate.rawContract),
      contractSha256: expectedHash,
      stdout: redactWithCredentials(productionOutput(candidate, model, result), credentials),
      stderr: '',
    };
    await writeProductionRecord(options.recordPath, rawCapture, productionCapture, 'PASS');
    return {
      exitCode: PROVIDER_CONFORMANCE_EXIT_CODES.PASS,
      verdict: 'PASS',
      candidateId: candidate.rawContract.id,
      role: roleForContract(candidate.rawContract),
    };
  } catch (error) {
    const isHarness = hasConformanceCode(error, 'harness-failure');
    const reason = safeDiagnostic(error, credentials);
    const productionCapture = {
      candidateId: candidate.rawContract.id,
      role: roleForContract(candidate.rawContract),
      contractSha256: expectedHash,
      stdout: '',
      stderr: reason,
    };
    await writeProductionRecord(options.recordPath, rawCapture, productionCapture, 'OMIT');
    return {
      exitCode: isHarness
        ? PROVIDER_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE
        : PROVIDER_CONFORMANCE_EXIT_CODES.OMIT,
      verdict: 'OMIT',
      candidateId: candidate.rawContract.id,
      role: roleForContract(candidate.rawContract),
      reason,
    };
  }
}
