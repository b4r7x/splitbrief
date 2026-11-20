import type { RecoveryAction } from '../../src/core/schemas/enums.js';
import type { RecoveryIssue, SwitchSeatOffer } from '../../src/core/schemas/recovery/schemas.js';
import { taskId } from '../../src/core/schemas/task.js';
import { recoveryMenuRow } from '../../src/features/workflow/recovery/menu-label.js';

export const baseIssue: RecoveryIssue = {
  id: 'rec_test',
  reason: 'retry-exhausted',
  phase: 'escalating',
  status: 'awaiting-user',
  taskId: taskId('T003'),
  taskTitle: 'Patch auth validation',
  files: ['src/auth/session.ts', 'src/auth/session.test.ts'],
  affectedTaskIds: [taskId('T003')],
  message: 'T003 failed',
  details: [
    'Validation test failed: npm test -- auth failed in src/auth/session.test.ts',
    'Attempts: 3',
    'Worker profile: local-qwen',
  ],
  selectedImplementerProfile: 'local-qwen',
  facts: {
    validationStage: 'test',
    validationSummary: 'npm test -- auth failed',
  },
  availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
  recommendedAction: 'retry-same-worker',
  createdAt: '2026-04-29T12:00:00.000Z',
};

export function recoveryMenuText(action: RecoveryAction, issue: RecoveryIssue): string {
  const row = recoveryMenuRow(action, issue, false, false);
  return [row.name, row.description].filter(Boolean).join(' · ');
}

export function usageLimitIssue(candidates: SwitchSeatOffer['candidates']): RecoveryIssue {
  return {
    ...baseIssue,
    reason: 'runner-usage-limit',
    message: 'Codex hit its usage limit',
    details: ['Codex reported: 5-hour limit reached'],
    facts: {},
    switchSeat: { seat: 'build', candidates },
    availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
    recommendedAction: 'switch-seat',
  };
}

export function apiContextIssue(overrides: Partial<RecoveryIssue> = {}): RecoveryIssue {
  return {
    id: 'rec_api_context',
    reason: 'planner-call-failed',
    seat: 'plan',
    phase: 'planning',
    status: 'awaiting-user',
    files: [],
    affectedTaskIds: [],
    message:
      'The planning seat was not given the context this call needs, so nothing was dispatched. Evidence this call requires is missing. Missing: evidence.json, drift-report.json',
    details: [
      'Missing: evidence.json, drift-report.json',
      'Pick a plan seat with a larger context in /crew plan, then choose Try again.',
    ],
    facts: {
      apiContextCode: 'insufficient-context',
      apiContextSeat: 'plan',
      apiContextCause: 'missing-required',
      apiContextMissingSectionsJson: '["evidence.json","drift-report.json"]',
      apiContextModel: 'qwen3-coder-30b',
      apiContextInputEstimate: 148_000,
      apiContextRequiredTokens: 156_000,
      apiContextAvailableTokens: 32_768,
    },
    availableActions: ['retry-same-worker', 'end-run'],
    recommendedAction: 'retry-same-worker',
    createdAt: '2026-04-29T12:00:00.000Z',
    ...overrides,
  };
}
