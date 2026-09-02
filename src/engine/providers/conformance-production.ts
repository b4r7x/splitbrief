import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CandidateEvidence,
  CONFORMANCE_PROMPT,
  UnregisteredProviderCandidate,
  contractSha256,
  normalizeCandidateEvidence,
} from './candidate-contract.js';
import { streamCompletion } from './openai-stream/completion.js';
import type { RunnerCallResult } from '../calls/types.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  COMPLETION_TIMEOUT_MS,
  PROVIDER_CONFORMANCE_EXIT_CODES,
  type ProviderConformanceFetchOptions,
  type ProviderConformanceOutcome,
  type ProviderConformanceVerdict,
  type RawCapture,
  type UnregisteredProviderCandidateValue,
  chooseModel,
  hasConformanceCode,
  redactWithCredentials,
  roleForContract,
  safeDiagnostic,
  throwConformance,
} from './conformance.js';
import {
  type UnregisteredOpenAICompatProvider,
  createUnregisteredOpenAICompatProvider,
} from './unregistered-provider.js';

export interface ProductionProviderConformanceOptions extends ProviderConformanceFetchOptions {
  readonly modulePath: string;
  readonly recordPath: string;
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
