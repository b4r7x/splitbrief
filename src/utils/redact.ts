const DEFAULT_REDACTION_MARKER = '***REDACTED***';

type RedactionReplacement = string | ((substring: string, ...args: string[]) => string);

interface RedactionRule {
  pattern: RegExp;
  replacement: (marker: string) => RedactionReplacement;
}

export interface RedactSecretsOptions {
  marker?: string | undefined;
}

export interface RedactSecretsResult {
  text: string;
  redacted: boolean;
}

// Order matters: structured multi-line secrets first, specific prefixes before generic sk-,
// then keyword-contextual patterns.
const KEY_PATTERNS: RedactionRule[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: (marker) => `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----`,
  },
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: (marker) => `sk-ant-${marker}` },
  { pattern: /sk-or-[a-zA-Z0-9_-]{20,}/g, replacement: (marker) => `sk-or-${marker}` },
  { pattern: /gsk_[a-zA-Z0-9_-]{20,}/g, replacement: (marker) => `gsk_${marker}` },
  { pattern: /xai-[a-zA-Z0-9_-]{20,}/g, replacement: (marker) => `xai-${marker}` },
  { pattern: /glhf_[a-zA-Z0-9_-]{20,}/g, replacement: (marker) => `glhf_${marker}` },
  { pattern: /AIza[a-zA-Z0-9_-]{20,}/g, replacement: (marker) => `AIza${marker}` },
  { pattern: /github_pat_[A-Za-z0-9_]{12,}/g, replacement: (marker) => `github_pat_${marker}` },
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, replacement: (marker) => `ghp_${marker}` },
  { pattern: /gho_[A-Za-z0-9]{20,}/g, replacement: (marker) => `gho_${marker}` },
  {
    pattern: /\b(xox[baprs])[-_][A-Za-z0-9_=-]{8,}\b/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}-${marker}`,
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: (marker) => marker,
  },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: (marker) => `AKIA${marker}` },
  { pattern: /\bsk-[a-zA-Z0-9_-]{20,}\b/g, replacement: (marker) => `sk-${marker}` },
  { pattern: /\bBearer\s+[a-zA-Z0-9._~+/=-]{8,}\b/gi, replacement: (marker) => `Bearer ${marker}` },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    replacement: (marker) => (_match, protocol: string) => `${protocol}${marker}@`,
  },
  {
    pattern:
      /\b((?:[A-Z0-9_.-]*(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|X-API-KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN)[A-Z0-9_.-]*)\s*[:=]\s*)(['"]?)[A-Za-z0-9._~+/=-]+\2(?=\s|$|[;,.)])/gi,
    replacement: (marker) => (_match, prefix: string, quote: string) =>
      `${prefix}${quote}${marker}${quote}`,
  },
  {
    pattern:
      /(?<=(?:api[_-]?key|token|secret|credential|password|authorization|x-api-key)\s*[:=]\s*["']?)[a-zA-Z0-9+/=_-]{40,}/gi,
    replacement: (marker) => marker,
  },
  {
    pattern:
      /((?:api[_-]?key|token|secret|credential|password|authorization)\s*[=:]\s*["']?)[a-zA-Z0-9+/=_-]{20,}/gi,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
];

export function redactSecretsWithMetadata(
  msg: string,
  opts: RedactSecretsOptions = {},
): RedactSecretsResult {
  const marker = opts.marker ?? DEFAULT_REDACTION_MARKER;
  let result = msg;
  let redacted = false;
  for (const { pattern, replacement } of KEY_PATTERNS) {
    const replacementValue = replacement(marker);
    result = result.replace(pattern, (...args) => {
      redacted = true;
      return typeof replacementValue === 'string'
        ? replacementValue
        : replacementValue(args[0], ...args.slice(1));
    });
  }
  return { text: result, redacted };
}

export function redactSecrets(msg: string): string {
  return redactSecretsWithMetadata(msg).text;
}
