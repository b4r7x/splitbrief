import { describe, expect, it } from 'vitest';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import { typedOutputError } from '../../../runners/typed-output.js';
import type { SeatSwapContext } from './task.js';
import {
  buildSeatProtocolErrorRecoveryIssue,
  type SeatProtocolRecoveryOptions,
} from './seat-protocol.js';

const createdAt = '2026-10-01T00:00:00.000Z';

function expectValidRecoveryIssue(issue: unknown): void {
  const result = RecoveryIssueSchema.safeParse(issue);
  expect(result.success).toBe(true);
}

const plannerSeatSwap: SeatSwapContext = {
  seat: 'plan',
  currentTool: 'codex',
  detectedTools: [
    { tool: 'claude-code', ready: true },
    { tool: 'codex', ready: true },
    { tool: 'opencode', ready: false },
  ],
};

const error = typedOutputError.seatProtocol({
  seat: 'reviewer',
  attempts: 2,
  transport: 'native',
  errors: '✖ Invalid input',
  answerPreview: '{}',
});

const input: SeatProtocolRecoveryOptions = {
  error,
  phase: 'final-review',
  createdAt,
};

describe('buildSeatProtocolErrorRecoveryIssue', () => {
  it('builds a schema-valid issue for the halted seat', () => {
    expectValidRecoveryIssue(buildSeatProtocolErrorRecoveryIssue(input));
  });

  it('names the reason, the seat, the message and the validation errors', () => {
    const issue = buildSeatProtocolErrorRecoveryIssue(input);

    expect(issue.reason).toBe('seat-protocol-error');
    expect(issue.seat).toBe('review');
    expect(issue.message).toBe(error.message);
    expect(issue.details).toEqual(['✖ Invalid input']);
  });

  it('records the transport and the attempt count as facts', () => {
    const issue = buildSeatProtocolErrorRecoveryIssue(input);

    expect(issue.facts?.transport).toBe('native');
    expect(issue.facts?.attempts).toBe('2');
  });

  it('offers no seat swap without a detected alternative and recommends the retry', () => {
    const issue = buildSeatProtocolErrorRecoveryIssue(input);

    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
  });

  it('offers the seat swap when another ready tool was detected', () => {
    const issue = buildSeatProtocolErrorRecoveryIssue({
      ...input,
      error: typedOutputError.seatProtocol({ ...error.data, seat: 'planner' }),
      seatSwap: plannerSeatSwap,
    });

    expect(issue.seat).toBe('plan');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'switch-seat', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
  });
});
