const ELLIPSIS = '\u2026';

const GLUED_SENSITIVE_KEY_NAMES = 'CLIENTSECRET|CLIENTTOKEN|PRIVATETOKEN|AUTHTOKEN';

// A key with the noun CREDENTIAL or CREDENTIALS and a final STORE segment names
// the backend that keeps credentials, so its value stays readable. With any other
// noun, a final STORE segment stays sensitive.
const SENSITIVE_KEY_NAME = `(?:(?:[A-Z0-9]+[_.-])*(?:API[_-]?KEY|TOKENS?|PASSWORD|PASSWD|SECRETS?|CREDENTIALS?(?![_.-]STORE["']?\\s*[:=])|AUTHORIZATION|X[_-]API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN)(?:[_.-][A-Z0-9]+)*|${GLUED_SENSITIVE_KEY_NAMES})`;

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

export const ASSIGNED_SECRET_PATTERN = new RegExp(
  String.raw`((?<![A-Z0-9])(?:"${SENSITIVE_KEY_NAME}"|'${SENSITIVE_KEY_NAME}'|${SENSITIVE_KEY_NAME})(?![A-Z0-9])\s*[:=]\s*)("(?:\\.|[^"\\])+"(?![\w$-]*"\s*:)|'(?:\\.|[^'\\])+'|Bearer\s+[A-Z0-9._~+/*=-]+|\S+)`,
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

export function replaceAssignedSecret(
  marker: string,
  previouslyRedactedValues: ReadonlySet<string>,
): (match: string, prefix: string, value: string, offset: number, fullString: string) => string {
  return (match, prefix, value, offset, fullString) => {
    const quote = value.at(0);
    const hasMatchingQuotes = (quote === '"' || quote === "'") && value.at(-1) === quote;
    const unquotedValue = hasMatchingQuotes ? value.slice(1, -1) : value;
    const cutMarkerPrefix = unquotedValue.endsWith(ELLIPSIS)
      ? unquotedValue.slice(0, -ELLIPSIS.length)
      : null;
    const isCutRedaction =
      unquotedValue === ELLIPSIS ||
      (cutMarkerPrefix !== null &&
        cutMarkerPrefix.length > 0 &&
        marker.startsWith(cutMarkerPrefix));
    if (
      unquotedValue === marker ||
      unquotedValue.endsWith(` ${marker}`) ||
      isCutRedaction ||
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
