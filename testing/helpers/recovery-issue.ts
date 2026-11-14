import { expect } from 'vitest';
import { RecoveryIssueSchema } from '../../src/core/schemas/recovery/schemas.js';

export const createdAt = '2026-04-28T12:00:00.000Z';

export const LONG_PLANNER_REASON = `The type test needs a decision on what alpha exports. ${'word '.repeat(70)}alpha-reason-end`;

export function expectValidRecoveryIssue(issue: unknown): void {
  const result = RecoveryIssueSchema.safeParse(issue);
  expect(result.success).toBe(true);
}
