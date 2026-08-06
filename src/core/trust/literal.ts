const AMBIGUOUS_DISPLAY_CODE_POINTS =
  /[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * Renders a repository-supplied string as an unambiguous terminal literal.
 * Quoting is what makes argument boundaries visible; escaping the bidi and
 * zero-width ranges is what stops a command from painting itself as a
 * different one in the disclosure the owner is about to authorize.
 */
export function escapeTrustLiteral(value: string): string {
  return JSON.stringify(value).replace(AMBIGUOUS_DISPLAY_CODE_POINTS, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
