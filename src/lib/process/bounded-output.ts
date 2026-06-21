export type BoundedOutputPolicy = 'tail' | 'prefix-tail';

export interface BoundedOutputMetadata {
  text: string;
  bytesSeen: number;
  bytesStored: number;
  omittedBytes: number;
  truncated: boolean;
  policy: BoundedOutputPolicy;
  maxBytes: number;
}

export interface BoundedOutput {
  append(chunk: string): void;
  snapshot(): BoundedOutputMetadata;
}

interface BoundedOutputOptions {
  maxBytes: number;
  policy?: BoundedOutputPolicy | undefined;
}

interface PrefixTailBudget {
  prefixBytes: number;
  tailBytes: number;
}

const TRUNCATION_MARKER = '\n[... output truncated ...]\n';
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');

interface VisibleOutput {
  text: string;
  originalBytes: number;
}

export function createBoundedOutput(opts: BoundedOutputOptions): BoundedOutput {
  const maxBytes = Math.max(0, Math.floor(opts.maxBytes));
  const policy = opts.policy ?? 'tail';
  const budget = prefixTailBudget(maxBytes);
  let bytesSeen = 0;
  let text = '';
  let tail = '';
  let truncated = false;

  return {
    append(chunk: string): void {
      if (chunk.length === 0 || maxBytes === 0) {
        bytesSeen += Buffer.byteLength(chunk, 'utf8');
        truncated = truncated || bytesSeen > 0;
        text = '';
        tail = '';
        return;
      }

      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      bytesSeen += chunkBytes;

      if (policy === 'tail') {
        text = appendTail(text, chunk, maxBytes);
        truncated = bytesSeen > Buffer.byteLength(text, 'utf8');
        return;
      }

      if (!truncated && bytesSeen <= maxBytes) {
        text += chunk;
        return;
      }

      if (!truncated) {
        const previous = text;
        text = appendPrefix(previous, chunk, budget.prefixBytes);
        tail =
          chunkBytes >= budget.tailBytes
            ? takeUtf8TailBytes(chunk, budget.tailBytes)
            : takeUtf8TailBytes(previous + chunk, budget.tailBytes);
        truncated = true;
        return;
      }

      tail = appendTail(tail, chunk, budget.tailBytes);
    },
    snapshot(): BoundedOutputMetadata {
      const retained = visibleOutput({ policy, maxBytes, truncated, text, tail });
      const bytesStored = Buffer.byteLength(retained.text, 'utf8');
      return {
        text: retained.text,
        bytesSeen,
        bytesStored,
        omittedBytes: Math.max(0, bytesSeen - retained.originalBytes),
        truncated,
        policy,
        maxBytes,
      };
    },
  };
}

function visibleOutput(opts: {
  policy: BoundedOutputPolicy;
  maxBytes: number;
  truncated: boolean;
  text: string;
  tail: string;
}): VisibleOutput {
  if (!opts.truncated) return { text: opts.text, originalBytes: Buffer.byteLength(opts.text) };
  if (opts.maxBytes <= 0) return { text: '', originalBytes: 0 };
  if (TRUNCATION_MARKER_BYTES >= opts.maxBytes) {
    return { text: takeUtf8PrefixBytes(TRUNCATION_MARKER, opts.maxBytes), originalBytes: 0 };
  }

  const contentBytes = opts.maxBytes - TRUNCATION_MARKER_BYTES;
  if (opts.policy === 'tail') {
    const tail = takeUtf8TailBytes(opts.text, contentBytes);
    return { text: `${TRUNCATION_MARKER}${tail}`, originalBytes: Buffer.byteLength(tail) };
  }

  const prefixBudget = Math.floor(contentBytes / 2);
  const prefix = takeUtf8PrefixBytes(opts.text, prefixBudget);
  const tailBudget = contentBytes - Buffer.byteLength(prefix, 'utf8');
  const tail = takeUtf8TailBytes(opts.tail, tailBudget);
  return {
    text: `${prefix}${TRUNCATION_MARKER}${tail}`,
    originalBytes: Buffer.byteLength(prefix) + Buffer.byteLength(tail),
  };
}

function prefixTailBudget(maxBytes: number): PrefixTailBudget {
  if (maxBytes <= 0) return { prefixBytes: 0, tailBytes: 0 };

  const prefixBytes = Math.ceil(maxBytes / 2);
  return { prefixBytes, tailBytes: maxBytes - prefixBytes };
}

function appendPrefix(previous: string, chunk: string, maxBytes: number): string {
  const previousBytes = Buffer.byteLength(previous, 'utf8');
  if (previousBytes >= maxBytes) return takeUtf8PrefixBytes(previous, maxBytes);
  return previous + takeUtf8PrefixBytes(chunk, maxBytes - previousBytes);
}

function appendTail(previous: string, chunk: string, maxBytes: number): string {
  const chunkBytes = Buffer.byteLength(chunk, 'utf8');
  if (chunkBytes >= maxBytes) return takeUtf8TailBytes(chunk, maxBytes);
  return takeUtf8TailBytes(previous + chunk, maxBytes);
}

function takeUtf8PrefixBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';

  let bytes = 0;
  let result = '';
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function takeUtf8TailBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';

  const chars = Array.from(text);
  let bytes = 0;
  let result = '';
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i];
    if (char === undefined) continue;
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    result = `${char}${result}`;
    bytes += charBytes;
  }
  return result;
}
