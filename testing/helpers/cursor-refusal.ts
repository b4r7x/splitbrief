import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Captured live from `cursor-agent --print --output-format stream-json`: on an account whose plan
 * does not include the model, it printed this on stderr, wrote no result record and exited 1. The
 * capture joined the lines, so the forms cover a line break and a full stop before "Buy".
 */
export const CURSOR_MODEL_REFUSAL =
  'ActionRequiredError: Claude Haiku 5.5 is not included in your weekly usage Buy credits or switch to a Grok model to continue.';

export const CURSOR_MODEL_REFUSAL_FORMS = [
  ['one line', CURSOR_MODEL_REFUSAL],
  [
    'two lines',
    'ActionRequiredError: Claude Haiku 5.5 is not included in your weekly usage\nBuy credits or switch to a Grok model to continue.',
  ],
  [
    'a full stop',
    'ActionRequiredError: Claude Haiku 5.5 is not included in your weekly usage. Buy credits or switch to a Grok model to continue.',
  ],
] as const;

/**
 * A `cursor-agent` shim: every call starts a session on stdout, prints the refusal on stderr and
 * exits 1. With `firstFailure`, the first call prints those words instead, so the refusal comes
 * on the retry.
 */
export function writeCursorRefusalShim(
  dir: string,
  opts: Readonly<{ stderr?: string; firstFailure?: string }> = {},
): void {
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const refusal = quote(opts.stderr ?? CURSOR_MODEL_REFUSAL);
  const counter = join(dir, 'cursor-calls');
  const body = [
    '#!/bin/bash',
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s1"}'`,
    ...(opts.firstFailure === undefined
      ? [`printf '%s\\n' ${refusal} >&2`]
      : [
          `if [ ! -e ${quote(counter)} ]; then`,
          `  touch ${quote(counter)}`,
          `  printf '%s\\n' ${quote(opts.firstFailure)} >&2`,
          'else',
          `  printf '%s\\n' ${refusal} >&2`,
          'fi',
        ]),
    'exit 1',
  ];
  writeFileSync(join(dir, 'cursor-agent'), `${body.join('\n')}\n`, { mode: 0o755 });
}
