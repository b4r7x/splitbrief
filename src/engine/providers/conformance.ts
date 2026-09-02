import type { z } from 'zod';
import { normalizeProviderEndpoint } from '../../core/providers/endpoint-policy.js';
import type { EndpointPolicyFetch } from '../../lib/http/policy-fetch.js';
import {
  type CandidateEvidence,
  CONFORMANCE_EXIT_CODES,
  MAX_EVIDENCE_OUTPUT_BYTES,
  type RawProviderCandidateContract,
  type UnregisteredProviderCandidate,
  baseUrlEnvironmentName,
  sanitizeCandidateOutput,
} from './candidate-contract.js';
import { sanitizeProviderDiagnostic, type ProviderDiagnosticOptions } from './client/request.js';
import { isRecord } from '../../utils/type-guards.js';
import { error as createError } from '../../utils/error.js';

export const COMPLETION_TIMEOUT_MS = 30_000;

export const PROVIDER_CONFORMANCE_EXIT_CODES = CONFORMANCE_EXIT_CODES;

export type ProviderConformanceExitCode =
  (typeof PROVIDER_CONFORMANCE_EXIT_CODES)[keyof typeof PROVIDER_CONFORMANCE_EXIT_CODES];
export type ProviderConformanceVerdict = 'PASS' | 'OMIT';
export type ConformanceRole = 'planner' | 'implementer';

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

export type UnregisteredProviderCandidateValue = z.infer<typeof UnregisteredProviderCandidate>;
export type CandidateKnownModel = UnregisteredProviderCandidateValue['knownModels'][number];
export type RawCapture = z.infer<typeof CandidateEvidence>['rawCapture'];

type ConformanceErrorCode = 'credentialed-omit' | 'harness-failure';

function conformanceError(code: ConformanceErrorCode, message: string): Error {
  return createError(code, message);
}

export function hasConformanceCode(value: unknown, code: ConformanceErrorCode): boolean {
  return isRecord(value) && value.kind === code;
}

export function throwConformance(code: ConformanceErrorCode, message: string): never {
  throw conformanceError(code, message);
}

export function environmentOf(
  options: ProviderConformanceFetchOptions,
): ProviderConformanceEnvironment {
  return options.environment ?? process.env;
}

export function boundedCandidateOutput(value: string): string {
  return sanitizeCandidateOutput(value, MAX_EVIDENCE_OUTPUT_BYTES);
}

export function redactWithCredentials(value: string, credentialValues: readonly string[]): string {
  let sanitized = value;
  for (const credential of credentialValues) {
    if (credential.length === 0) continue;
    sanitized = sanitized.replaceAll(credential, '[REDACTED]');
  }
  return boundedCandidateOutput(sanitized);
}

function diagnosticOptions(credentials: readonly string[]): ProviderDiagnosticOptions {
  return credentials.length === 0 ? {} : { credentialValues: credentials };
}

export function safeDiagnostic(error: unknown, credentials: readonly string[]): string {
  return redactWithCredentials(
    sanitizeProviderDiagnostic(error, diagnosticOptions(credentials)),
    credentials,
  );
}

export function roleForContract(contract: RawProviderCandidateContract): ConformanceRole {
  const [role] = contract.roles;
  if (role === undefined) throwConformance('harness-failure', 'provider contract has no role');
  return role;
}

export function credentialForContract(
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

export function endpointForContract(
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

export function bearerHeaders(credential: string): Record<string, string> | undefined {
  return credential.length === 0 ? undefined : { Authorization: `Bearer ${credential}` };
}

export function chooseModel(
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
