import { domainToASCII } from 'node:url';
import { parse } from 'tldts';

const URI_REFERENCE_PATTERN = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:[^\s'"<>{}]+)/giu;
const TRAILING_PROSE_PUNCTUATION_PATTERN = /[!),.;?\]}]+$/u;
const STATUS_LABEL_PATTERN = /^[a-z][a-z0-9+.-]*:[a-z0-9_-]+$/iu;
const URI_ONLY_SCHEMES = new Set([
  'data',
  'file',
  'ftp',
  'ftps',
  'mailto',
  'mongodb',
  'mysql',
  'postgres',
  'postgresql',
  'redis',
  'sftp',
  'ssh',
  'tel',
  'urn',
  'ws',
  'wss',
]);
const MAX_NESTED_URL_DEPTH = 4;

export interface NetworkReferenceScanOptions {
  readonly value: string;
  readonly requireCanonical?: boolean;
}

export function containsUnsafeNetworkReference(options: NetworkReferenceScanOptions): boolean {
  return containsUnsafeNetworkReferenceAtDepth({
    value: options.value,
    requireCanonical: options.requireCanonical ?? true,
    depth: 0,
  });
}

export function isPublicHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized.length === 0 || normalized.length > 253) return false;
  if (!normalized.includes('.') || domainToASCII(normalized) !== normalized) return false;

  const parsed = parse(normalized, {
    allowIcannDomains: true,
    allowPrivateDomains: true,
    detectIp: true,
    detectSpecialUse: true,
    extractHostname: false,
    mixedInputs: false,
    validateHostname: true,
  });

  return (
    parsed.hostname === normalized &&
    parsed.domain !== null &&
    parsed.isIp === false &&
    parsed.isIcann === true &&
    parsed.isPrivate === false &&
    parsed.isSpecialUse === false &&
    parsed.publicSuffix !== 'arpa' &&
    !parsed.publicSuffix?.endsWith('.arpa')
  );
}

function containsUnsafeNetworkReferenceAtDepth(options: {
  readonly value: string;
  readonly requireCanonical: boolean;
  readonly depth: number;
}): boolean {
  const { value, requireCanonical, depth } = options;
  for (const match of value.matchAll(URI_REFERENCE_PATTERN)) {
    const candidate = trimTrailingProsePunctuation(match[1] ?? '');
    const scheme = candidate.slice(0, candidate.indexOf(':')).toLowerCase();
    if (isStatusLabel(candidate, scheme)) continue;
    if (scheme !== 'http' && scheme !== 'https') return true;
    if (!candidate.toLowerCase().startsWith(`${scheme}://`)) return true;
    if (!isSafeHttpUrl({ value: candidate, requireCanonical, depth })) return true;
  }
  return false;
}

function isStatusLabel(candidate: string, scheme: string): boolean {
  return !URI_ONLY_SCHEMES.has(scheme) && STATUS_LABEL_PATTERN.test(candidate);
}

function isSafeHttpUrl(options: {
  readonly value: string;
  readonly requireCanonical: boolean;
  readonly depth: number;
}): boolean {
  const { value, requireCanonical, depth } = options;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname !== normalizeHostname(url.hostname) ||
    !isPublicHostname(url.hostname) ||
    (requireCanonical && !isCanonicalHttpUrl(value, url))
  ) {
    return false;
  }
  if (depth >= MAX_NESTED_URL_DEPTH) return false;

  return getNestedUrlValues(url).every(
    (nested) =>
      !containsUnsafeNetworkReferenceAtDepth({
        value: nested,
        requireCanonical: false,
        depth: depth + 1,
      }),
  );
}

function getNestedUrlValues(url: URL): readonly string[] {
  const values = [decodeUrlComponent(url.pathname), decodeUrlComponent(url.hash.slice(1))];
  for (const [key, value] of url.searchParams) {
    values.push(key, value);
  }
  return values;
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isCanonicalHttpUrl(value: string, url: URL): boolean {
  if (url.href === value) return true;
  return url.pathname === '/' && url.search === '' && url.hash === '' && url.href === `${value}/`;
}

function trimTrailingProsePunctuation(value: string): string {
  return value.replace(TRAILING_PROSE_PUNCTUATION_PATTERN, '');
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, '');
}
