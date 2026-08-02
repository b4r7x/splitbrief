import { z } from 'zod';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text.js';
import { warnError } from '../../../lib/warn.js';
import { redactSecrets } from '../../../utils/redact.js';
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

export async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const policyFetch = createEndpointPolicyFetch(url, endpointPolicyError.invalid);
  const res = await policyFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw providerError.httpFailure(res.status, sanitizeProviderDiagnostic(url));
  return await res.json();
}

export async function fetchModelList<T>(options: {
  endpoint: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetch?: EndpointPolicyFetch | undefined;
  onError?: ((err: string | undefined) => void) | undefined;
  extractModels: (data: unknown) => T[] | null;
}): Promise<T[]> {
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
    const signal = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
    const policyFetch =
      options.fetch ?? createEndpointPolicyFetch(endpoint, endpointPolicyError.invalid);
    const res = await policyFetch(endpoint, headers ? { headers, signal } : { signal });
    if (!res.ok) {
      reportError(`HTTP ${res.status}`);
      return [];
    }
    const json: unknown = await res.json();
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
    const headers = options.headers ?? (apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined);
    const diagnostic = sanitizeProviderDiagnostic(err, {
      credentialValues: apiKey ? [apiKey] : undefined,
      headers,
    });
    onError?.(diagnostic);
    const isNetworkError = err instanceof TypeError || (err instanceof Error && 'code' in err);
    if (!isNetworkError) {
      warnError('fetchModelList', diagnostic);
    }
    return [];
  }
}
