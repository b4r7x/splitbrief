import { shellQuoteArg } from '../../src/utils/shell-quote.js';

/** Places probe branches before the required stdin read. The body runs after EOF. */
export function promptCliScript(options: {
  body: string;
  probes?: string;
  capturePath?: string | undefined;
  shell?: '/bin/sh' | '/bin/bash';
}): string {
  return [
    `#!${options.shell ?? '/bin/sh'}`,
    options.probes ?? '',
    readCliPrompt(options.capturePath),
    options.body,
    '',
  ].join('\n');
}

export function readCliPrompt(capturePath?: string): string {
  const destination = capturePath === undefined ? '/dev/null' : shellQuoteArg(capturePath);
  return `/bin/cat > ${destination} || exit 1`;
}

export function nodeCliScript(body: string): string {
  return `require('node:fs').readFileSync(0);\n${body}`;
}
