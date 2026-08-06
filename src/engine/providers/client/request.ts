import { z } from 'zod';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text.js';
import { warnError } from '../../../lib/warn.js';
import { redactSecrets } from '../../../utils/redact.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { providerError } from '../errors.js';
import { endpointPolicyError } from '../../../core/providers/endpoint-policy.js';
import {
  createEndpointPolicyFetch,
  type EndpointPolicyFetch,
} from '../../../lib/http/policy-fetch.js';

const OpenAIModelItemSchema = z.looseObject({
  id: z.string(),
});

const OpenAIModelListSchema = z.object({
  data: z.array(OpenAIModelItemSchema),
});

export function extractOpenAIModelList<T>(
  data: unknown,
  mapper: (model: z.infer<typeof OpenAIModelListSchema>['data'][number]) => T,
): T[] {
  const result = OpenAIModelListSchema.safeParse(data);
  if (!result.success) return [];
  return result.data.data.map(mapper);
}

export function isOpenAIModelList(data: unknown): boolean {
  return OpenAIModelListSchema.safeParse(data).success;
}

const MODEL_LIST_TIMEOUT_MS = 5_000;
const PROVIDER_DIAGNOSTIC_REDACTION_MARKER = '***REDACTED***';

const SENSITIVE_QUERY_PARAMETER_PATTERN =
  /([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret|token|key)=)[^&#\s"'<>}]*/gi;

export interface ProviderDiagnosticOptions {
  credentialValues?: readonly (string | undefined)[] | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * Provider errors can include values that are not covered by the generic
 * secret-pattern redactor (for example a short test key or a provider's
 * custom header). Scrub the exact values at this boundary before they reach
 * detection, availability state, warnings, or persistence.
 */
export function sanitizeProviderDiagnostic(
  input: unknown,
  options: ProviderDiagnosticOptions = {},
): string {
  let text = input instanceof Error ? input.message : String(input);
  const values = [...(options.credentialValues ?? []), ...Object.values(options.headers ?? {})];

  for (const value of values) {
    if (!value || value === PROVIDER_DIAGNOSTIC_REDACTION_MARKER) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern =
      value.length < 4
        ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g')
        : new RegExp(escaped, 'g');
    text = text.replace(pattern, PROVIDER_DIAGNOSTIC_REDACTION_MARKER);
  }

  text = text.replace(
    SENSITIVE_QUERY_PARAMETER_PATTERN,
    `$1${PROVIDER_DIAGNOSTIC_REDACTION_MARKER}`,
  );
  return sanitizeTerminalDiagnosticText(redactSecrets(text));
}

/**
 * A provider endpoint that is not listening — connection refused, DNS failure,
 * TLS reset, timeout abort — is a fact about the machine, and every caller of
 * this module already handles it by falling back. Writing it to stderr only
 * puts an internal probe name and a bare `fetch failed` in front of a user who
 * has not seen the UI yet; readiness is where an unreachable endpoint is
 * reported. Anything else that goes wrong is still worth a diagnostic.
 */
export function isEndpointUnreachable(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && 'code' in err);
}

export interface FetchJsonWithTimeoutOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export async function fetchJsonWithTimeout(options: FetchJsonWithTimeoutOptions): Promise<unknown> {
  throwIfAborted(options.signal);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  const policyFetch = createEndpointPolicyFetch(options.url, endpointPolicyError.invalid);
  const res = await policyFetch(options.url, { signal });
  throwIfAborted(options.signal);
  if (!res.ok) throw providerError.httpFailure(res.status, sanitizeProviderDiagnostic(options.url));
  const json = await res.json();
  throwIfAborted(options.signal);
  return json;
}

export async function fetchModelList<T>(options: {
  endpoint: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetch?: EndpointPolicyFetch | undefined;
  onError?: ((err: string | undefined) => void) | undefined;
  signal?: AbortSignal | undefined;
  extractModels: (data: unknown) => T[] | null;
}): Promise<T[]> {
  throwIfAborted(options.signal);
  const { endpoint, apiKey, onError, extractModels } = options;
  try {
    const headers = options.headers ?? (apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined);
    const diagnosticOptions: ProviderDiagnosticOptions = {
      credentialValues: apiKey ? [apiKey] : undefined,
      headers,
    };
    const reportError = (message: string | undefined): void => {
      onError?.(
        message === undefined ? undefined : sanitizeProviderDiagnostic(message, diagnosticOptions),
      );
    };
    const timeoutSignal = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal]);
    const policyFetch =
      options.fetch ?? createEndpointPolicyFetch(endpoint, endpointPolicyError.invalid);
    const res = await policyFetch(endpoint, headers ? { headers, signal } : { signal });
    throwIfAborted(options.signal);
    if (!res.ok) {
      reportError(`HTTP ${res.status}`);
      return [];
    }
    const json: unknown = await res.json();
    throwIfAborted(options.signal);
    if (typeof json !== 'object' || json === null) {
      reportError('Invalid response payload');
      return [];
    }
    const result = extractModels(json);
    if (result === null) {
      reportError('Invalid response payload');
      return [];
    }
    reportError(undefined);
    return result;
  } catch (err) {
    throwIfAborted(options.signal);
    const headers = options.headers ?? (apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined);
    const diagnostic = sanitizeProviderDiagnostic(err, {
      credentialValues: apiKey ? [apiKey] : undefined,
      headers,
    });
    onError?.(diagnostic);
    if (!isEndpointUnreachable(err)) {
      warnError('fetchModelList', diagnostic);
    }
    return [];
  }
}
