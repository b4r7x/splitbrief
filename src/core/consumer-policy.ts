import { redactSecretsWithMetadata } from '../utils/redact.js';
import {
  SESSION_LOG_MAX_ENTRY_BYTES,
  SESSION_LOG_MAX_STRING_BYTES,
} from './schemas/session-log.js';
import { stripTerminalControls } from '../utils/display-text.js';

export const CALL_IPC_MAX_PUBLIC_PAYLOAD_BYTES = 512 * 1024;
export const CALL_STDOUT_JSON_MAX_PUBLIC_PAYLOAD_BYTES = 256 * 1024;
export const CALL_RPC_MAX_PUBLIC_PAYLOAD_BYTES = 128 * 1024;
export const CALL_HOOKS_MAX_PUBLIC_PAYLOAD_BYTES = 64 * 1024;
export const CALL_OTEL_MAX_PUBLIC_PAYLOAD_BYTES = 8 * 1024;
export const CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES = SESSION_LOG_MAX_ENTRY_BYTES;
export const CALL_TREE_MAX_PUBLIC_PAYLOAD_BYTES = SESSION_LOG_MAX_ENTRY_BYTES;

export const CALL_IPC_MAX_PUBLIC_STRING_BYTES = 64 * 1024;
export const CALL_STDOUT_JSON_MAX_PUBLIC_STRING_BYTES = 32 * 1024;
export const CALL_RPC_MAX_PUBLIC_STRING_BYTES = 32 * 1024;
export const CALL_HOOKS_MAX_PUBLIC_STRING_BYTES = 16 * 1024;
export const CALL_OTEL_MAX_PUBLIC_STRING_BYTES = 2 * 1024;
export const CALL_SESSION_LOG_MAX_PUBLIC_STRING_BYTES = SESSION_LOG_MAX_STRING_BYTES;
export const CALL_TREE_MAX_PUBLIC_STRING_BYTES = SESSION_LOG_MAX_STRING_BYTES;

export const CALL_CONSUMER_REDACTION_MARKER = '***REDACTED***';
export const CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER = '\n[... oversized string truncated ...]';
export const CALL_CONSUMER_OVERSIZED_PAYLOAD_PLACEHOLDER = '[... oversized payload omitted ...]';
export const CALL_CONSUMER_UNSUPPORTED_VALUE_PLACEHOLDER =
  '[... unsupported payload value omitted ...]';
export const CALL_CONSUMER_CIRCULAR_REFERENCE_PLACEHOLDER =
  '[... circular payload reference omitted ...]';

export type CallConsumerContext =
  | 'ipc'
  | 'stdout-json'
  | 'rpc'
  | 'hooks'
  | 'otel'
  | 'session-log'
  | 'tree';

export type PublicPayload =
  | string
  | number
  | boolean
  | null
  | PublicPayload[]
  | { [key: string]: PublicPayload };

export interface ConsumerPayloadPolicy {
  readonly context: CallConsumerContext;
  readonly maxBytes: number;
  readonly maxStringBytes: number;
}

export interface ConsumerPayloadPolicyOverrides {
  readonly maxBytes?: number | undefined;
  readonly maxStringBytes?: number | undefined;
}

export interface ConsumerPayloadResult {
  readonly payload: PublicPayload;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly oversized: boolean;
}

export interface RedactedPublicPayloadResult {
  readonly payload: PublicPayload;
  readonly redacted: boolean;
}

const CONSUMER_POLICIES: Record<CallConsumerContext, ConsumerPayloadPolicy> = {
  ipc: {
    context: 'ipc',
    maxBytes: CALL_IPC_MAX_PUBLIC_PAYLOAD_BYTES,
    maxStringBytes: CALL_IPC_MAX_PUBLIC_STRING_BYTES,
  },
  'stdout-json': {
    context: 'stdout-json',
    maxBytes: CALL_STDOUT_JSON_MAX_PUBLIC_PAYLOAD_BYTES,
    maxStringBytes: CALL_STDOUT_JSON_MAX_PUBLIC_STRING_BYTES,
  },
  rpc: {
    context: 'rpc',
    maxBytes: CALL_RPC_MAX_PUBLIC_PAYLOAD_BYTES,
    maxStringBytes: CALL_RPC_MAX_PUBLIC_STRING_BYTES,
  },
  hooks: {
    context: 'hooks',
    maxBytes: CALL_HOOKS_MAX_PUBLIC_PAYLOAD_BYTES,
    maxStringBytes: CALL_HOOKS_MAX_PUBLIC_STRING_BYTES,
  },
  otel: {
    context: 'otel',
    maxBytes: CALL_OTEL_MAX_PUBLIC_PAYLOAD_BYTES,
    maxStringBytes: CALL_OTEL_MAX_PUBLIC_STRING_BYTES,
  },
  'session-log': {
    context: 'session-log',
    maxBytes: CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES,
    maxStringBytes: CALL_SESSION_LOG_MAX_PUBLIC_STRING_BYTES,
  },
  tree: {
    context: 'tree',
    maxBytes: CALL_TREE_MAX_PUBLIC_PAYLOAD_BYTES,
    maxStringBytes: CALL_TREE_MAX_PUBLIC_STRING_BYTES,
  },
};

const OMIT_VALUE = Symbol('omit-value');

type PayloadTransformValue = PublicPayload | typeof OMIT_VALUE;

interface PayloadTransformState {
  readonly maxStringBytes: number;
  readonly seen: WeakSet<object>;
  redacted: boolean;
  truncated: boolean;
}

export function getConsumerPayloadPolicy(
  context: CallConsumerContext,
  overrides: ConsumerPayloadPolicyOverrides = {},
): ConsumerPayloadPolicy {
  const base = CONSUMER_POLICIES[context];
  return {
    context: base.context,
    maxBytes: overrides.maxBytes ?? base.maxBytes,
    maxStringBytes: overrides.maxStringBytes ?? base.maxStringBytes,
  };
}

export function redactPublicPayload(opts: {
  readonly payload: unknown;
}): RedactedPublicPayloadResult {
  const state = createTransformState(Number.MAX_SAFE_INTEGER);
  const payload = normalizePublicPayloadValue(opts.payload, state);
  return {
    payload: payload === OMIT_VALUE ? null : payload,
    redacted: state.redacted,
  };
}

export function boundPublicPayload(opts: {
  readonly payload: unknown;
  readonly policy: ConsumerPayloadPolicy;
}): ConsumerPayloadResult {
  const state = createTransformState(opts.policy.maxStringBytes);
  const transformed = normalizePublicPayloadValue(opts.payload, state);
  const payload = transformed === OMIT_VALUE ? null : transformed;
  const bytes = measurePublicPayloadBytes(payload);
  if (bytes <= opts.policy.maxBytes) {
    return {
      payload,
      bytes,
      maxBytes: opts.policy.maxBytes,
      redacted: state.redacted,
      truncated: state.truncated,
      oversized: false,
    };
  }

  const omittedPayload = fitStringPayloadToMaxBytes(
    CALL_CONSUMER_OVERSIZED_PAYLOAD_PLACEHOLDER,
    opts.policy.maxBytes,
  );
  return {
    payload: omittedPayload,
    bytes: measurePublicPayloadBytes(omittedPayload),
    maxBytes: opts.policy.maxBytes,
    redacted: state.redacted,
    truncated: true,
    oversized: true,
  };
}

export function protectConsumerPayload(opts: {
  readonly context: CallConsumerContext;
  readonly payload: unknown;
  readonly overrides?: ConsumerPayloadPolicyOverrides | undefined;
}): ConsumerPayloadResult {
  return boundPublicPayload({
    payload: opts.payload,
    policy: getConsumerPayloadPolicy(opts.context, opts.overrides),
  });
}

export function measurePublicPayloadBytes(payload: PublicPayload): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? 'null', 'utf8');
}

function createTransformState(maxStringBytes: number): PayloadTransformState {
  return {
    maxStringBytes,
    seen: new WeakSet<object>(),
    redacted: false,
    truncated: false,
  };
}

function normalizePublicPayloadValue(
  value: unknown,
  state: PayloadTransformState,
): PayloadTransformValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      return sanitizeString(value, state);
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'undefined':
      return OMIT_VALUE;
    case 'bigint':
    case 'function':
    case 'symbol':
      state.truncated = true;
      return CALL_CONSUMER_UNSUPPORTED_VALUE_PLACEHOLDER;
    case 'object':
      return normalizeObjectPayloadValue(value, state);
    default:
      state.truncated = true;
      return CALL_CONSUMER_UNSUPPORTED_VALUE_PLACEHOLDER;
  }
}

function normalizeObjectPayloadValue(value: object, state: PayloadTransformState): PublicPayload {
  if (state.seen.has(value)) {
    state.truncated = true;
    return CALL_CONSUMER_CIRCULAR_REFERENCE_PLACEHOLDER;
  }

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const next = normalizePublicPayloadValue(item, state);
        return next === OMIT_VALUE ? null : next;
      });
    }

    const output: { [key: string]: PublicPayload } = {};
    for (const [key, item] of Object.entries(value)) {
      const next = normalizePublicPayloadValue(item, state);
      if (next !== OMIT_VALUE) output[sanitizeString(key, state)] = next;
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

function sanitizeString(value: string, state: PayloadTransformState): string {
  const clean = stripPublicStringControls(value);
  const redacted = redactSecretsWithMetadata(clean, { marker: CALL_CONSUMER_REDACTION_MARKER });
  if (redacted.redacted) state.redacted = true;

  const bounded = truncateUtf8String(redacted.text, state.maxStringBytes);
  if (bounded.truncated) state.truncated = true;
  return bounded.text;
}

function stripPublicStringControls(value: string): string {
  return value
    .split('\n')
    .map((line) =>
      line
        .split('\t')
        .map((part) => stripTerminalControls(part))
        .join('\t'),
    )
    .join('\n');
}

function truncateUtf8String(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: value.length > 0 };
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };

  const suffixBytes = Buffer.byteLength(CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER, 'utf8');
  if (suffixBytes >= maxBytes) {
    return {
      text: truncateRawUtf8String(CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER, maxBytes),
      truncated: true,
    };
  }

  const maxPrefixBytes = maxBytes - suffixBytes;
  return {
    text: `${truncateRawUtf8String(value, maxPrefixBytes).trimEnd()}${CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER}`,
    truncated: true,
  };
}

function truncateRawUtf8String(value: string, maxBytes: number): string {
  let output = '';
  let bytes = 0;
  for (const char of value) {
    const nextBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + nextBytes > maxBytes) break;
    output += char;
    bytes += nextBytes;
  }
  return output;
}

function fitStringPayloadToMaxBytes(value: string, maxBytes: number): string {
  if (measurePublicPayloadBytes(value) <= maxBytes) return value;
  return truncateRawUtf8String(value, Math.max(maxBytes - 2, 0));
}
