import { z } from 'zod';
import { redactSecretsWithMetadata } from '../../../src/utils/redact.js';
import { containsUnsafeNetworkReference, isPublicHostname } from './network-policy.js';
import { containsHostPath } from './path-policy.js';

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const BIDI_CONTROL_PATTERN = /\p{Bidi_Control}/u;
const LONE_SURROGATE_PATTERN = /\p{Cs}/u;
const LINE_OR_PARAGRAPH_SEPARATOR_PATTERN = /[\u2028\u2029]/u;
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u;
const DEFAULT_IGNORABLE_GLOBAL_PATTERN = /\p{Default_Ignorable_Code_Point}/gu;
const PERCENT_OCTET_RUN_PATTERN = /(?:%[0-9a-f]{2})+/giu;
const PERCENT_OCTET_PRESENT_PATTERN = /%[0-9a-f]{2}/iu;
const ENCODED_TOKEN_PATTERN =
  /(^|[^A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{12,}={0,2})(?=$|[^A-Za-z0-9+/_=-])/gu;
const HEX_TOKEN_PATTERN = /(^|[^0-9A-Fa-f])([0-9A-Fa-f]{16,})(?=$|[^0-9A-Fa-f])/gu;
const MAX_DECODE_DEPTH = 4;
const MAX_DECODE_VARIANTS = 32;
const MAX_ENCODED_TOKEN_LENGTH = 8_192;
const MAX_PERSISTED_TEXT_LENGTH = 65_536;

interface DecodedVariant {
  readonly value: string;
  readonly deobfuscated: boolean;
}

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true });

export const PersistedDiagnosticTextSchema = z.string().refine(isSafePersistedTerminalText, {
  message: 'diagnostic text contains unsafe terminal data, a secret, a host path, or a private URL',
});

export const PersistedMetadataTextSchema = z.string().refine(isSafePersistedTerminalText, {
  message: 'metadata contains unsafe terminal data, a secret, a host path, or a private URL',
});

export const NonBlankPersistedTextSchema = PersistedDiagnosticTextSchema.refine(
  (value) => value.trim().length > 0,
  { message: 'persisted text must contain a non-whitespace character' },
);

export const ToolVersionSchema = PersistedMetadataTextSchema.min(1)
  .max(80)
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/,
  );

export const GitRevisionSchema = PersistedMetadataTextSchema.min(7)
  .max(64)
  .regex(/^[0-9a-f]{7,64}$/);

export { isPublicHostname };

export function isSafeTerminalGrapheme(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 64 ||
    containsUnsafeTerminalUnicode(value) ||
    !containsVisibleCodePoint(value)
  ) {
    return false;
  }

  const segments = graphemeSegmenter.segment(value)[Symbol.iterator]();
  if (segments.next().done) return false;
  return segments.next().done === true;
}

export function isSafePersistedTerminalText(value: string): boolean {
  return isSafePersistedText(value);
}

export function isSafePersistedText(value: string): boolean {
  if (value.length > MAX_PERSISTED_TEXT_LENGTH) return false;
  const decodedVariants = decodeVisualObfuscation(value);
  if (decodedVariants === null) return false;

  return decodedVariants.every(
    (variant) => !containsUnsafePersistedData(variant.value, !variant.deobfuscated),
  );
}

export function containsUnsafePathUnicode(value: string): boolean {
  return containsUnsafeTerminalUnicode(value) || DEFAULT_IGNORABLE_PATTERN.test(value);
}

function containsUnsafePersistedData(value: string, requireCanonicalUrl: boolean): boolean {
  return (
    containsUnsafeTerminalUnicode(value) ||
    (value.length > 0 && !containsVisibleCodePoint(value)) ||
    redactSecretsWithMetadata(value).redacted ||
    containsHostPath(value) ||
    containsUnsafeNetworkReference({ value, requireCanonical: requireCanonicalUrl })
  );
}

function containsVisibleCodePoint(value: string): boolean {
  return value.replace(DEFAULT_IGNORABLE_GLOBAL_PATTERN, '').length > 0;
}

function containsUnsafeTerminalUnicode(value: string): boolean {
  return (
    CONTROL_CHARACTER_PATTERN.test(value) ||
    BIDI_CONTROL_PATTERN.test(value) ||
    LONE_SURROGATE_PATTERN.test(value) ||
    LINE_OR_PARAGRAPH_SEPARATOR_PATTERN.test(value)
  );
}

function decodeVisualObfuscation(value: string): readonly DecodedVariant[] | null {
  const stripped = value.replace(DEFAULT_IGNORABLE_GLOBAL_PATTERN, '');
  const variants: DecodedVariant[] = [{ value, deobfuscated: false }];
  const seen = new Set([value]);
  if (!addVariant({ value: stripped, deobfuscated: true }, variants, seen)) return null;

  let depthStart = 0;
  for (let depth = 0; depth < MAX_DECODE_DEPTH; depth += 1) {
    const depthEnd = variants.length;
    for (const variant of variants.slice(depthStart, depthEnd)) {
      const decoded = decodeVariant(variant.value);
      if (decoded === null) return null;
      for (const candidate of decoded) {
        if (!addVariant({ value: candidate, deobfuscated: true }, variants, seen)) return null;
      }
    }
    if (variants.length === depthEnd) break;
    depthStart = depthEnd;
  }
  if (hasUnresolvedDeobfuscation(variants, seen)) return null;
  return variants;
}

function decodeVariant(value: string): readonly string[] | null {
  if (hasOversizedEncodedToken(value)) return null;
  const percentDecoded = decodePercentOctets(value);
  if (percentDecoded === null) return null;

  return [
    percentDecoded,
    replaceEncodedTokens(value, decodeBase64Token),
    replaceEncodedTokens(value, decodeBase64UrlToken),
    replaceEncodedTokens(value, decodeHexToken, HEX_TOKEN_PATTERN),
  ].filter((candidate) => candidate !== value);
}

function hasUnresolvedDeobfuscation(
  variants: readonly DecodedVariant[],
  seen: ReadonlySet<string>,
): boolean {
  for (const variant of variants) {
    const decoded = decodeVariant(variant.value);
    if (decoded === null || decoded.some((candidate) => !seen.has(candidate))) return true;
  }
  return false;
}

function hasOversizedEncodedToken(value: string): boolean {
  for (const match of value.matchAll(ENCODED_TOKEN_PATTERN)) {
    if ((match[2]?.length ?? 0) > MAX_ENCODED_TOKEN_LENGTH) return true;
  }
  return false;
}

function decodePercentOctets(value: string): string | null {
  let failed = false;
  const decoded = value.replace(PERCENT_OCTET_RUN_PATTERN, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      failed = true;
      return encoded;
    }
  });
  return failed ? null : decoded;
}

function replaceEncodedTokens(
  value: string,
  decodeToken: (token: string) => string | null,
  pattern = ENCODED_TOKEN_PATTERN,
): string {
  return value.replace(pattern, (match, prefix: string, token: string) => {
    if (token.length > MAX_ENCODED_TOKEN_LENGTH) return match;
    const decoded = decodeToken(token);
    if (!decoded || !isRelevantDecodedText(decoded)) return match;
    return `${prefix}${decoded}`;
  });
}

function decodeBase64Token(token: string): string | null {
  if (/[-_]/u.test(token) || token.length % 4 !== 0) return null;
  const bytes = Buffer.from(token, 'base64');
  if (bytes.toString('base64') !== token) return null;
  return decodeUtf8(bytes);
}

function decodeBase64UrlToken(token: string): string | null {
  if (/[+/]/u.test(token)) return null;
  const unpadded = token.replace(/=+$/u, '');
  const paddingLength = token.length - unpadded.length;
  const expectedPaddingLength = (4 - (unpadded.length % 4)) % 4;
  if (unpadded.length % 4 === 1 || (paddingLength > 0 && paddingLength !== expectedPaddingLength)) {
    return null;
  }
  const bytes = Buffer.from(unpadded, 'base64url');
  if (bytes.toString('base64url') !== unpadded) return null;
  return decodeUtf8(bytes);
}

function decodeHexToken(token: string): string | null {
  if (token.length % 2 !== 0) return null;
  const bytes = Buffer.from(token, 'hex');
  if (bytes.toString('hex') !== token.toLowerCase()) return null;
  return decodeUtf8(bytes);
}

function decodeUtf8(value: Uint8Array): string | null {
  try {
    return strictTextDecoder.decode(value);
  } catch {
    return null;
  }
}

function isRelevantDecodedText(value: string): boolean {
  if (value.length < 4) return false;
  if (containsUnsafePersistedData(value, false)) return true;
  return isStrictEncodedToken(value) || PERCENT_OCTET_PRESENT_PATTERN.test(value);
}

function isStrictEncodedToken(value: string): boolean {
  if (value.length > MAX_ENCODED_TOKEN_LENGTH) return false;
  return (
    decodeBase64Token(value) !== null ||
    decodeBase64UrlToken(value) !== null ||
    (/^[0-9A-Fa-f]{16,}$/u.test(value) && decodeHexToken(value) !== null)
  );
}

function addVariant(
  candidate: DecodedVariant,
  variants: DecodedVariant[],
  seen: Set<string>,
): boolean {
  if (seen.has(candidate.value)) return true;
  if (variants.length >= MAX_DECODE_VARIANTS) return false;
  seen.add(candidate.value);
  variants.push(candidate);
  return true;
}
