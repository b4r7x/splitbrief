import { EngineEventSchema } from '../../../src/engine/events/schema.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';

/** The first sentence of agy's quota words, which a narrow Recovery detail still shows whole. */
export const AGY_QUOTA_LEAD = 'Individual quota reached.';
export const AGY_QUOTA_WORDS = `${AGY_QUOTA_LEAD} Please upgrade your subscription to increase your limits. Resets in 144h5m54s.`;
export const AGY_QUOTA_MODEL = 'gemini-4-argon-high';
export const AGY_QUOTA_TASK_ID = 'T006';
export const AGY_QUOTA_FILE = 'src/features/workflow/components/header.tsx';
const ISSUE_ID = 'rec_20261108153804_runner_usage_limit_escalating_T006';
const HEADLINE = 'Usage limit on Google Antigravity CLI · resets Nov 14, 16:43';

/** The halt on the consult and the automatic switch to the declared PLAN fallback, as the run recorded them. */
export function haltAndSwitch(ts: number): EngineEvent[] {
  return [
    {
      type: 'recovery_prompted',
      ts,
      taskId: AGY_QUOTA_TASK_ID,
      phase: 'escalating',
      issueId: ISSUE_ID,
      reason: 'runner-usage-limit',
      files: [AGY_QUOTA_FILE],
      affectedTaskIds: [AGY_QUOTA_TASK_ID],
      availableActions: [
        'retry-same-worker',
        'switch-seat',
        'retry-later',
        'skip-current-task',
        'end-run',
      ],
      recommendedAction: 'switch-seat',
      headline: HEADLINE,
      headlineSpans: [{ text: HEADLINE }],
      resumeCommand:
        'splitbrief continue 2026-11-08-no-drift-row-the-whole-stuck-reason-a-short-questi --action switch-seat:claude-code:claude-opus-5-5@high',
    },
    {
      type: 'recovery_action_selected',
      ts: ts + 1,
      phase: 'escalating',
      issueId: ISSUE_ID,
      reason: 'runner-usage-limit',
      action: 'switch-seat',
      seat: 'plan',
    },
    {
      type: 'seat_switched',
      ts: ts + 2,
      phase: 'escalating',
      switchId: '80b7dc15-7684-4d70-862a-a969adc7c3c0',
      seat: 'plan',
      from: { tool: 'antigravity', model: AGY_QUOTA_MODEL },
      to: { tool: 'claude-code', model: 'claude-opus-5-5', effort: 'high' },
      cause: 'runner-usage-limit',
      headline: HEADLINE,
      auto: true,
      configRevision: '867017212d64a395f02d76b0b7232e1146c274e6a1f726fa8671610cf6b95a06',
    },
    {
      type: 'recovery_resolved',
      ts: ts + 3,
      phase: 'escalating',
      issueId: ISSUE_ID,
      reason: 'runner-usage-limit',
      action: 'switch-seat',
      seat: 'plan',
      outcome: 'retry-current-task',
    },
  ].map((event) => EngineEventSchema.parse(event));
}
