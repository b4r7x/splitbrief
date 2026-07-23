import { z } from 'zod';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { warnError } from '../../../lib/warn.js';
import { redactSecrets } from '../../../utils/redact.js';
import { providerError } from '../errors.js';

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

export async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw providerError.httpFailure(res.status, redactSecrets(url));
  return await res.json();
}

export async function fetchModelList<T>(options: {
  endpoint: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  onError?: ((err: string | undefined) => void) | undefined;
  extractModels: (data: unknown) => T[] | null;
}): Promise<T[]> {
  const { endpoint, apiKey, onError, extractModels } = options;
  try {
    const headers = options.headers ?? (apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined);
    const signal = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
    const res = await fetch(endpoint, headers ? { headers, signal } : { signal });
    if (!res.ok) {
      onError?.(`HTTP ${res.status}`);
      return [];
    }
    const json: unknown = await res.json();
    if (typeof json !== 'object' || json === null) {
      onError?.('Invalid response payload');
      return [];
    }
    const result = extractModels(json);
    if (result === null) {
      onError?.('Invalid response payload');
      return [];
    }
    onError?.(undefined);
    return result;
  } catch (err) {
    onError?.(toErrorMessage(err));
    const isNetworkError = err instanceof TypeError || (err instanceof Error && 'code' in err);
    if (!isNetworkError) {
      warnError(`fetchModelList(${endpoint})`, err);
    }
    return [];
  }
}
