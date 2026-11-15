import { randomUUID } from 'node:crypto';

export function createRunnerCallId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
