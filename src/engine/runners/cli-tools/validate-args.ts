import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';

type CliArgumentValidation =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; conflicts: readonly string[] }>;

const ALTERNATE_PLACEHOLDER_PATTERN = /^<[^>]+>$/;
const CURLY_PROMPT_PATTERN = /\{prompt\}/i;

function placeholderConflict(value: string): boolean {
  return (
    value.includes(CLI_PROMPT_SENTINEL) ||
    ALTERNATE_PLACEHOLDER_PATTERN.test(value) ||
    CURLY_PROMPT_PATTERN.test(value)
  );
}

function protectedFlag(input: {
  value: string;
  protectedFlags: ReadonlySet<string>;
  protectedShortValueFlags: ReadonlySet<string>;
}): string | null {
  const { value, protectedFlags, protectedShortValueFlags } = input;
  if (protectedFlags.has(value)) return value;
  if (!value.startsWith('-')) return null;
  const flag = value.split('=', 1)[0] ?? value;
  if (protectedFlags.has(flag)) return flag;
  if (value.startsWith('--')) return null;
  for (const shortFlag of protectedShortValueFlags) {
    if (
      shortFlag.length === 2 &&
      shortFlag.startsWith('-') &&
      protectedFlags.has(shortFlag) &&
      value.length > shortFlag.length &&
      value.startsWith(shortFlag)
    ) {
      return shortFlag;
    }
  }
  return null;
}

export function validateCliArgs(input: {
  readonly invocationArgs: readonly string[];
  readonly baseArgs: readonly string[];
  readonly protectedFlags: ReadonlySet<string>;
  readonly protectedShortValueFlags?: ReadonlySet<string> | undefined;
  readonly promptTransport: 'argv' | 'stdin';
}): CliArgumentValidation {
  const { invocationArgs, baseArgs, protectedFlags, promptTransport } = input;
  const protectedShortValueFlags = input.protectedShortValueFlags ?? new Set<string>();
  const conflicts: string[] = [];

  const orderConflict =
    invocationArgs.length < baseArgs.length ||
    baseArgs.some((arg, index) => invocationArgs[index] !== arg);
  if (orderConflict) conflicts.push('argument-order');

  if (
    promptTransport === 'argv' &&
    invocationArgs.filter((arg) => arg === CLI_PROMPT_SENTINEL).length !== 1
  ) {
    conflicts.push('prompt-transport');
  }
  if (invocationArgs.some((arg) => arg !== CLI_PROMPT_SENTINEL && placeholderConflict(arg))) {
    conflicts.push('prompt-transport');
  }

  // The configured tail is only identifiable when the adapter-owned prefix is intact.
  if (!orderConflict) {
    for (const arg of invocationArgs.slice(baseArgs.length)) {
      const flag = protectedFlag({ value: arg, protectedFlags, protectedShortValueFlags });
      if (flag !== null) conflicts.push(flag);
    }
  }

  const uniqueConflicts = [...new Set(conflicts)];
  return uniqueConflicts.length === 0
    ? { valid: true }
    : { valid: false, conflicts: uniqueConflicts };
}
