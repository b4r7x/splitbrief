import { assertNever } from '../../../../utils/type-guards.js';
import type { RunnerActivityDisplayInput, RunnerActivityLedgerLabel } from './types.js';

export function runnerActivityLedgerLabel(
  input: RunnerActivityDisplayInput,
  opts: { interrupted: boolean; shellCommand: boolean },
): RunnerActivityLedgerLabel {
  if (opts.interrupted) return 'STOP';
  if (/^tool Read$/i.test(input.label)) return 'READ';
  if (/^tool (Write|Edit|MultiEdit)$/i.test(input.label)) return 'EDIT';
  if (/^tool (Bash|Shell)$/i.test(input.label)) return 'RUN';

  switch (input.kind) {
    case 'warning':
      return 'WARN';
    case 'error':
      return 'ERR';
    case 'command':
      return 'RUN';
    case 'read':
    case 'file':
    case 'text':
      return 'READ';
    case 'write':
    case 'edit':
      return 'EDIT';
    case 'search':
    case 'glob':
      return 'FIND';
    case 'web':
    case 'mcp':
    case 'tool':
    case 'unknown':
      return opts.shellCommand ? 'RUN' : 'CALL';
    case 'plan':
      return 'PLAN';
    case 'task':
      return 'AGENT';
    default:
      return assertNever(input.kind);
  }
}

export function stripActivityVerb(text: string): string {
  const prefixes = [
    'aborted ',
    'running ',
    'reading ',
    'editing ',
    'searching ',
    'matching ',
    'calling ',
    'planning ',
    'task ',
    'warning ',
    'failed ',
    'timeout ',
    'truncated ',
    'refused ',
    'unsupported_tool ',
    'incomplete ',
  ];
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  return text;
}
