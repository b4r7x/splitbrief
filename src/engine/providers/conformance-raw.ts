import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { endpointPolicyError } from '../../core/providers/endpoint-policy.js';
import {
  createEndpointPolicyFetch,
  type EndpointPolicyFetch,
} from '../../lib/http/policy-fetch.js';
import {
  CONFORMANCE_PROMPT,
  RawProviderCandidateContract,
  contractSha256,
} from './candidate-contract.js';
import { extractOpenAIModelList, isOpenAIModelList } from './client/request.js';
import {
  COMPLETION_TIMEOUT_MS,
  PROVIDER_CONFORMANCE_EXIT_CODES,
  type ProviderConformanceFetchOptions,
  type ProviderConformanceOutcome,
  type RawCapture,
  bearerHeaders,
  boundedCandidateOutput,
  chooseModel,
  credentialForContract,
  endpointForContract,
  environmentOf,
  hasConformanceCode,
  redactWithCredentials,
  roleForContract,
  safeDiagnostic,
  throwConformance,
} from './conformance.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MODEL_LIST_TIMEOUT_MS = 5_000;

export interface RawProviderConformanceOptions extends ProviderConformanceFetchOptions {
  readonly contractJson: string;
  readonly recordPath: string;
}

interface ProbeResult {
  readonly status: number;
  // `text` is the full response and decides the verdict; `evidence` is the bounded,
  // redacted copy that is the only part written to the record.
  readonly text: string;
  readonly evidence: string;
  readonly body: unknown;
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
