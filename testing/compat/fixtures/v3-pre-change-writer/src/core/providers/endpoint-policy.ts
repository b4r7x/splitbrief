import type { EndpointPolicyFetch } from '../../lib/http/policy-fetch.js';
import { error } from '../../utils/error.js';

export type EndpointPolicy =
  | { readonly kind: 'fixed-origin'; readonly baseURL: string }
  | {
      readonly kind: 'allowed-https';
      readonly hosts: readonly string[];
      readonly pathSuffix: string;
    }
  | { readonly kind: 'loopback'; readonly defaultBaseURL: string };

export const endpointPolicyFetch = Symbol('endpoint-policy-fetch');

export interface EndpointPolicyFetchOwner {
  readonly [endpointPolicyFetch]: EndpointPolicyFetch;
}

export const endpointPolicyError = {
  invalid: () =>
    error('provider-endpoint-invalid', 'Provider endpoint does not satisfy its endpoint policy'),
  unsupported: () =>
    error('provider-endpoint-policy-unsupported', 'Provider endpoint policy is not implemented'),
} as const;

function getRawPathname(value: string): string {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd === -1) return '';
  const pathStart = value.indexOf('/', schemeEnd + 3);
  return pathStart === -1 ? '/' : value.slice(pathStart);
}

function parseFixedEndpoint(value: string): URL {
  if (
    value !== value.trim() ||
    /[^\x20-\x7e]/.test(value) ||
    value.includes('%') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw endpointPolicyError.invalid();
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw endpointPolicyError.invalid();
  }

  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.port !== '' ||
    getRawPathname(value) !== endpoint.pathname
  ) {
    throw endpointPolicyError.invalid();
  }

  return endpoint;
}

function normalizeBasePath(pathname: string): string {
  if (pathname === '/') return '';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function normalizeFixedOrigin(baseURL: string, input: string): string {
  const expected = parseFixedEndpoint(baseURL);
  const candidate = parseFixedEndpoint(input);
  const expectedPath = normalizeBasePath(expected.pathname);

  if (
    candidate.origin !== expected.origin ||
    normalizeBasePath(candidate.pathname) !== expectedPath
  ) {
    throw endpointPolicyError.invalid();
  }

  return `${expected.origin}${expectedPath}`;
}

const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKSPACE_HOST_PREFIX = '{workspaceId}.';

function isLowercaseAsciiHostname(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    value.split('.').every((label) => HOST_LABEL_PATTERN.test(label))
  );
}

function getRawAuthority(value: string): string {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd === -1) return '';
  const authorityStart = schemeEnd + 3;
  const pathStart = value.indexOf('/', authorityStart);
  return value.slice(authorityStart, pathStart === -1 ? value.length : pathStart);
}

function isAllowedHostDeclaration(value: string): boolean {
  if (!value.startsWith(WORKSPACE_HOST_PREFIX)) {
    return isLowercaseAsciiHostname(value);
  }

  return isLowercaseAsciiHostname(value.slice(WORKSPACE_HOST_PREFIX.length));
}

function matchesAllowedHost(hostname: string, declaration: string): boolean {
  if (!declaration.startsWith(WORKSPACE_HOST_PREFIX)) {
    return hostname === declaration;
  }

  const regionSuffix = declaration.slice(WORKSPACE_HOST_PREFIX.length);
  const suffix = `.${regionSuffix}`;
  if (!hostname.endsWith(suffix)) return false;

  const workspaceId = hostname.slice(0, -suffix.length);
  return HOST_LABEL_PATTERN.test(workspaceId);
}

function validatePathSuffix(pathSuffix: string): void {
  if (!pathSuffix.startsWith('/')) {
    throw endpointPolicyError.invalid();
  }

  const parsed = parseFixedEndpoint(`https://endpoint-policy.invalid${pathSuffix}`);
  if (parsed.pathname !== pathSuffix) {
    throw endpointPolicyError.invalid();
  }
}

function normalizeAllowedHttps(
  hosts: readonly string[],
  pathSuffix: string,
  input: string,
): string {
  if (hosts.length === 0 || hosts.some((host) => !isAllowedHostDeclaration(host))) {
    throw endpointPolicyError.invalid();
  }
  validatePathSuffix(pathSuffix);

  const candidate = parseFixedEndpoint(input);
  const rawAuthority = getRawAuthority(input);
  if (
    (rawAuthority !== candidate.hostname && rawAuthority !== `${candidate.hostname}:443`) ||
    !isLowercaseAsciiHostname(candidate.hostname) ||
    !hosts.some((host) => matchesAllowedHost(candidate.hostname, host)) ||
    candidate.pathname !== pathSuffix
  ) {
    throw endpointPolicyError.invalid();
  }

  return `${candidate.origin}${candidate.pathname}`;
}

function parseLoopbackEndpoint(value: string): URL {
  if (
    value !== value.trim() ||
    /[^\x20-\x7e]/.test(value) ||
    value.includes('%') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw endpointPolicyError.invalid();
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw endpointPolicyError.invalid();
  }

  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    getRawPathname(value) !== endpoint.pathname
  ) {
    throw endpointPolicyError.invalid();
  }

  return endpoint;
}

function isLoopbackHostname(hostname: string, rawHostname: string): boolean {
  if (hostname === 'localhost') return rawHostname.toLowerCase() === hostname;
  if (hostname === '[::1]') return true;

  const octets = hostname.split('.');
  return (
    rawHostname === hostname &&
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet)) &&
    octets.every((octet) => Number(octet) <= 255) &&
    octets[0] === '127'
  );
}

function getRawHostname(value: string): string {
  const authority = getRawAuthority(value);
  if (authority.startsWith('[')) {
    return authority.slice(0, authority.indexOf(']') + 1);
  }

  const portSeparator = authority.indexOf(':');
  return portSeparator === -1 ? authority : authority.slice(0, portSeparator);
}

function getExplicitPort(value: string): string {
  const authority = getRawAuthority(value);
  const portSeparator = authority.startsWith('[')
    ? authority.indexOf(':', authority.indexOf(']') + 1)
    : authority.indexOf(':');

  return portSeparator === -1 ? '' : authority.slice(portSeparator);
}

function normalizeLoopback(input: string): string {
  const candidate = parseLoopbackEndpoint(input);
  const pathname = normalizeBasePath(candidate.pathname);

  if (
    !isLoopbackHostname(candidate.hostname, getRawHostname(input)) ||
    (pathname !== '' && pathname !== '/v1')
  ) {
    throw endpointPolicyError.invalid();
  }

  return `${candidate.protocol}//${candidate.hostname}${getExplicitPort(input)}/v1`;
}

export function normalizeProviderEndpoint(policy: EndpointPolicy, input: string): string {
  switch (policy.kind) {
    case 'fixed-origin':
      return normalizeFixedOrigin(policy.baseURL, input);
    case 'allowed-https':
      return normalizeAllowedHttps(policy.hosts, policy.pathSuffix, input);
    case 'loopback':
      normalizeLoopback(policy.defaultBaseURL);
      return normalizeLoopback(input);
  }
}
