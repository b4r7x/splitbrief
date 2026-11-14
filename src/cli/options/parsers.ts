import { InvalidArgumentError } from 'commander';
import { OutputFormatSchema } from '../../core/schemas/enums.js';
import { type SeatDownPolicy, SEAT_DOWN_POLICIES } from '../../core/types/config-options.js';

export function collectOption(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`'${value}' is not a valid number.`);
  }
  return parsed;
}

export function parsePositiveIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`'${value}' must be a positive integer.`);
  }
  return parsed;
}

export function parseOutputFormatOption(value: string): string {
  const parsed = OutputFormatSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(
      `'${value}' is not a valid output format. Must be one of: ${OutputFormatSchema.options.join(', ')}.`,
    );
  }
  return parsed.data;
}

export function parseSeatDownPolicyOption(value: string): SeatDownPolicy {
  const policy = SEAT_DOWN_POLICIES.find((candidate) => candidate === value);
  if (policy === undefined) {
    throw new InvalidArgumentError(
      `'${value}' is not a valid seat-down policy. Must be one of: ${SEAT_DOWN_POLICIES.join(', ')}.`,
    );
  }
  return policy;
}

/**
 * A ref reaches `git diff` as a positional argument, where a leading `-` would
 * be read as an option (`--output=<file>` writes the diff to any path). Refs
 * cannot begin with `-` anyway, so rejecting the shape here costs nothing.
 */
export function parseGitRefOption(value: string): string {
  const ref = value.trim();
  if (ref === '') {
    throw new InvalidArgumentError('a git ref cannot be empty.');
  }
  if (ref.startsWith('-')) {
    throw new InvalidArgumentError(`'${value}' is not a git ref: a ref cannot start with '-'.`);
  }
  return ref;
}

export function parseEnvRefOption(value: string): string {
  return value.startsWith('env:') ? value : `env:${value}`;
}
