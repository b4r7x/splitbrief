export const DEFAULT_REDACTION_MARKER = '***REDACTED***';

type RedactionReplacement = string | ((substring: string, ...args: string[]) => string);

interface RedactionRule {
  pattern: RegExp;
  replacement: (marker: string) => RedactionReplacement;
}

const GLUED_SENSITIVE_KEY_NAMES = 'CLIENTSECRET|CLIENTTOKEN|PRIVATETOKEN|AUTHTOKEN';

const SENSITIVE_KEY_NAME = `(?:(?:[A-Z0-9]+[_.-])*(?:API[_-]?KEY|TOKENS?|PASSWORD|PASSWD|SECRETS?|CREDENTIALS?|AUTHORIZATION|X[_-]API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN)(?:[_.-][A-Z0-9]+)*|${GLUED_SENSITIVE_KEY_NAMES})`;

// Wider than the assigned-secret matcher above: a bare `KEY` or `AUTH` segment
// names a credential when it is an environment variable, while the same word in
// prose does not.
const CREDENTIAL_ENV_NAME_PATTERN = new RegExp(
  `(?:^|[_.-])(?:API[_.-]?KEY|KEY|TOKENS?|PASSWORD|PASSWD|SECRETS?|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:$|[_.-])|${GLUED_SENSITIVE_KEY_NAMES}`,
  'i',
);

/** Whether an environment variable name carries a credential value. */
export function isCredentialEnvironmentName(name: string): boolean {
  return CREDENTIAL_ENV_NAME_PATTERN.test(name);
}

const ASSIGNED_SECRET_PATTERN = new RegExp(
  String.raw`((?<![A-Z0-9])(?:"${SENSITIVE_KEY_NAME}"|'${SENSITIVE_KEY_NAME}'|${SENSITIVE_KEY_NAME})(?![A-Z0-9])\s*[:=]\s*)("(?:\\.|[^"\\])+"|'(?:\\.|[^'\\])+'|Bearer\s+[A-Z0-9._~+/*=-]+|\S+)`,
  'gi',
);

// Prose after a credential noun is not a credential: "Failed to refresh token:
// Permission denied" is an error message, not an assignment. A `=` assignment
// or an explicit PASSWORD/SECRET/API_KEY noun treats any single-token remainder
// as a credential; multi-word prose after the first token keeps the legacy
// shape heuristics. Quoted and Bearer values always count as credentials. A
// short pure-numeric value is a status code, not a credential: "Failed to
// refresh token: 401 Unauthorized" must keep its 401.
const UNQUOTED_CREDENTIAL_VALUE_PATTERN = /[0-9@#$%^&*+=/\\~_]|^bearer\s/i;
const MIN_UNQUOTED_CREDENTIAL_LENGTH = 24;
const STRONG_CREDENTIAL_KEY_PATTERN = /PASSWORD|PASSWD|SECRET|CREDENTIALS|API[_-]?KEY/i;

// `TOKEN` is the one credential noun that is also an ordinary English word, so
// it only names a credential when it stands in key position — first thing on
// its line or right after a structural delimiter (`TOKEN: v`, `  auth_token: v`,
// `{"a":1,token:v}`). Mid-sentence it is prose: "Failed to refresh token:
// denied" must survive intact.
const TOKEN_CREDENTIAL_KEY_PATTERN = /TOKENS?["']?\s*[:=]\s*$/i;
const KEY_POSITION_LINE_PREFIX_PATTERN = /(?:^|[{,[;])\s*$/;

function isStrongCredentialAssignment(
  fullString: string,
  keyOffset: number,
  prefix: string,
): boolean {
  if (/=\s*$/.test(prefix) || STRONG_CREDENTIAL_KEY_PATTERN.test(prefix)) return true;
  if (!TOKEN_CREDENTIAL_KEY_PATTERN.test(prefix)) return false;
  const lineStart = fullString.lastIndexOf('\n', keyOffset - 1) + 1;
  return KEY_POSITION_LINE_PREFIX_PATTERN.test(fullString.slice(lineStart, keyOffset));
}

function hasMultiWordProseRemainder(fullString: string, matchEnd: number): boolean {
  return /^\s+\S/.test(fullString.slice(matchEnd));
}

function isShortNumericStatusCode(unquotedValue: string): boolean {
  return /^\d+$/.test(unquotedValue) && unquotedValue.length < MIN_UNQUOTED_CREDENTIAL_LENGTH;
}

function isLegacyCredentialShapedValue(unquotedValue: string): boolean {
  if (isShortNumericStatusCode(unquotedValue)) return false;
  return (
    UNQUOTED_CREDENTIAL_VALUE_PATTERN.test(unquotedValue) ||
    unquotedValue.length >= MIN_UNQUOTED_CREDENTIAL_LENGTH
  );
}

interface CredentialValueContext {
  unquotedValue: string;
  quoted: boolean;
  hasProseRemainder: boolean;
  strongAssignment: boolean;
}

function isCredentialShapedValue({
  unquotedValue,
  quoted,
  hasProseRemainder,
  strongAssignment,
}: CredentialValueContext): boolean {
  if (quoted) return true;
  if (hasProseRemainder) return isLegacyCredentialShapedValue(unquotedValue);
  if (strongAssignment) return !isShortNumericStatusCode(unquotedValue);
  return isLegacyCredentialShapedValue(unquotedValue);
}

function replaceAssignedSecret(
  marker: string,
  previouslyRedactedValues: ReadonlySet<string>,
): (match: string, prefix: string, value: string, offset: number, fullString: string) => string {
  return (match, prefix, value, offset, fullString) => {
    const quote = value.at(0);
    const hasMatchingQuotes = (quote === '"' || quote === "'") && value.at(-1) === quote;
    const unquotedValue = hasMatchingQuotes ? value.slice(1, -1) : value;
    if (
      unquotedValue === marker ||
      unquotedValue.endsWith(` ${marker}`) ||
      previouslyRedactedValues.has(unquotedValue)
    ) {
      return match;
    }
    const isCredential = isCredentialShapedValue({
      unquotedValue,
      quoted: hasMatchingQuotes,
      hasProseRemainder: hasMultiWordProseRemainder(fullString, offset + match.length),
      strongAssignment: isStrongCredentialAssignment(fullString, offset, prefix),
    });
    if (!isCredential) {
      return match;
    }

    return `${prefix}${hasMatchingQuotes ? `${quote}${marker}${quote}` : marker}`;
  };
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
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
    replacement: (marker) => `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----`,
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?![\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)[\s\S]*$/g,
    replacement: (marker) => marker,
  },
  {
    pattern: /-----END PGP PRIVATE KEY BLOCK-----/g,
    replacement: (marker) => marker,
  },
  {
    pattern: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `sk-ant-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])sk-or-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `sk-or-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])gsk_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `gsk_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])xai-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `xai-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])glhf_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `glhf_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{20,128}(?![A-Za-z0-9])/g,
    replacement: (marker) => `hf_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])(do[por]_v1_)[A-Za-z0-9_-]{20,128}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])((?:s|r)k_(?:live|test)_)[A-Za-z0-9]{16,256}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])whsec_[A-Za-z0-9]{16,128}(?![A-Za-z0-9])/g,
    replacement: (marker) => `whsec_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9])/g,
    replacement: (marker) => `SG.${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])xapp-1-[A-Za-z0-9-]{20,256}(?![A-Za-z0-9])/g,
    replacement: (marker) => `xapp-1-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])pypi-[A-Za-z0-9_-]{20,256}(?![A-Za-z0-9])/g,
    replacement: (marker) => `pypi-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])GOCSPX-[A-Za-z0-9_-]{28}(?![A-Za-z0-9])/g,
    replacement: (marker) => `GOCSPX-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])sntrys_[A-Za-z0-9+/_=-]{64,512}(?![A-Za-z0-9])/g,
    replacement: (marker) => `sntrys_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])dapi[a-f0-9]{32}(?:-\d)?(?![A-Za-z0-9])/g,
    replacement: (marker) => `dapi${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])pul-[a-f0-9]{40}(?![A-Za-z0-9])/g,
    replacement: (marker) => `pul-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])lin_api_[A-Za-z0-9]{40}(?![A-Za-z0-9])/g,
    replacement: (marker) => `lin_api_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}(?![A-Za-z0-9])/g,
    replacement: (marker) => `glsa_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])glrt-[A-Za-z0-9_-]{20}(?![A-Za-z0-9])/g,
    replacement: (marker) => `glrt-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])NRAK-[A-Za-z0-9]{27}(?![A-Za-z0-9])/g,
    replacement: (marker) => `NRAK-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])PMAK-[A-Fa-f0-9]{24}-[A-Fa-f0-9]{34}(?![A-Za-z0-9])/g,
    replacement: (marker) => `PMAK-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `AIza${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{12,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `github_pat_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])(gh[opur]_)[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])(ghs_)[A-Za-z0-9._-]{36,}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `glpat-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `npm_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])(xox[baprs])[-_][A-Za-z0-9_=-]{8,256}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}-${marker}`,
  },
  {
    pattern:
      /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])/g,
    replacement: (marker) => marker,
  },
  {
    pattern: /(?<![A-Za-z0-9])(AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `sk-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9])/gi,
    replacement: (marker) => `Bearer ${marker}`,
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    replacement: (marker) => (_match, protocol: string) => `${protocol}${marker}@`,
  },
];

export function redactSecretsWithMetadata(
  msg: string,
  opts: RedactSecretsOptions = {},
): RedactSecretsResult {
  const marker = opts.marker ?? DEFAULT_REDACTION_MARKER;
  let result = msg;
  let redacted = false;
  const previouslyRedactedValues = new Set<string>();
  for (const { pattern, replacement } of KEY_PATTERNS) {
    const replacementValue = replacement(marker);
    result = result.replace(pattern, (...args) => {
      redacted = true;
      const replacedValue =
        typeof replacementValue === 'string'
          ? replacementValue
          : replacementValue(args[0], ...args.slice(1));
      previouslyRedactedValues.add(replacedValue);
      return replacedValue;
    });
  }
  const assignedSecretReplacement = replaceAssignedSecret(marker, previouslyRedactedValues);
  result = result.replace(
    ASSIGNED_SECRET_PATTERN,
    (match, prefix: string, value: string, offset: number, fullString: string) => {
      const replacedValue = assignedSecretReplacement(match, prefix, value, offset, fullString);
      if (replacedValue !== match) redacted = true;
      return replacedValue;
    },
  );
  return { text: result, redacted };
}

export function redactSecrets(msg: string): string {
  return redactSecretsWithMetadata(msg).text;
}
