import { redactSecrets } from '../redact/secrets.js';

const ESC = '\\u001b';
const BEL = '\\u0007';
const STRING_TERMINATOR = '\\u009c';
const CSI = '\\u009b';
const OSC = '\\u009d';
const C0_CONTROL_RANGE_EXCEPT_WHITESPACE = '\\u0000-\\u0008\\u000e-\\u001f';
const C1_CONTROL_RANGE = '\\u007f-\\u009f';

const OSC_SEQUENCE_PATTERN = new RegExp(
  `(?:${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\|$)|${OSC}[\\s\\S]*?(?:${BEL}|${STRING_TERMINATOR}|$))`,
  'g',
);
const STRING_CONTROL_SEQUENCE_PATTERN = new RegExp(
  `(?:${ESC}[\\u0050\\u0058\\u005e\\u005f][\\s\\S]*?(?:${ESC}\\\\|$)|[\\u0090\\u0098\\u009e\\u009f][\\s\\S]*?(?:${STRING_TERMINATOR}|$))`,
  'g',
);
const CSI_SEQUENCE_PATTERN = new RegExp(
  `(?:${ESC}\\[[0-?]*[ -/]*[@-~]|${CSI}[0-?]*[ -/]*[@-~])`,
  'g',
);
const ESCAPE_SEQUENCE_PATTERN = new RegExp(`${ESC}(?:[ -/]*[@-~]|[@-Z\\\\-_])`, 'g');
const CONTROL_CHARACTER_EXCEPT_WHITESPACE_PATTERN = new RegExp(
  `[${C0_CONTROL_RANGE_EXCEPT_WHITESPACE}${C1_CONTROL_RANGE}]`,
  'g',
);
const WHITESPACE_CONTROL_RUN_PATTERN = /[\t\n\v\f\r]+/g;
const WHITESPACE_CONTROL_EXCEPT_LINE_BREAK_PATTERN = /[\t\v\f]/g;

export interface TerminalDisplayTextOptions {
  preserveLineBreaks?: boolean | undefined;
}

/**
 * Escape sequences and controls removed. A line break or a tab becomes a space, never nothing, so
 * the words on each side stay apart: on one row each run of them is one space; with
 * `preserveLineBreaks` a line break stays (`\r\n` and `\r` as `\n`) and each tab is one space.
 */
export function stripTerminalControls(text: string, opts: TerminalDisplayTextOptions = {}): string {
  const stripped = text
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(STRING_CONTROL_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ESCAPE_SEQUENCE_PATTERN, '')
    .replace(CONTROL_CHARACTER_EXCEPT_WHITESPACE_PATTERN, '');

  return opts.preserveLineBreaks
    ? stripped.replace(/\r\n?/g, '\n').replace(WHITESPACE_CONTROL_EXCEPT_LINE_BREAK_PATTERN, ' ')
    : stripped.replace(WHITESPACE_CONTROL_RUN_PATTERN, ' ');
}

export function sanitizeTerminalDisplayText(
  text: string,
  opts: TerminalDisplayTextOptions = {},
): string {
  return redactSecrets(stripTerminalControls(text, opts));
}

/** Text on one row: controls stripped, secrets redacted, spaces made single and trimmed. */
export function oneLineDisplayText(text: string): string {
  return sanitizeTerminalDisplayText(text).replace(/\s+/g, ' ').trim();
}

/**
 * A one-line label with its invisible format characters (`\p{Cf}`) removed and its spaces
 * single. `stripTerminalControls` keeps them, because a ZWJ binds an emoji sequence in prose.
 */
export function normalizeDisplayLabel(text: string): string {
  return stripTerminalControls(text)
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
