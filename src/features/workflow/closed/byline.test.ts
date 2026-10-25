import type { StepRef } from '../../../core/schemas/run-step.js';
import type { RunStatus } from '../../../core/sessions/run-status.js';
import { describe, expect, it } from 'vitest';
import { WIDE, endedInBuild, makeView } from '#testing/helpers/factories/summary-view.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { taskId } from '../../../core/schemas/task.js';
import { RECOVERY_ACTIONS, type RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { bylineParts, legendText, openRunBylineParts } from './byline.js';
import { stopPoint } from '../stop/copy.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';

function joinedByline(parts: readonly ConversationRowSegment[]): string {
  return parts.map((part) => part.text).join('');
}

function bylineText(view: Parameters<typeof bylineParts>[0], width: number): string {
  return joinedByline(bylineParts(view, width));
}

function openRunByline(input: Parameters<typeof openRunBylineParts>[0]): string {
  return joinedByline(openRunBylineParts(input));
}

describe('bylineText', () => {
  it('offers the undo on an applied run', () => {
    expect(bylineText(makeView({ outcome: { kind: 'applied' } }), WIDE)).toBe(
      'Undo the Apply with /run reject confirm',
    );
  });

  it('offers no undo when an applied record has no usable Apply backup', () => {
    expect(bylineText(makeView({ outcome: { kind: 'applied' }, canUndoApply: false }), WIDE)).toBe(
      '',
    );
  });

  it('says how to bring the changes of a discarded run back', () => {
    const view = makeView({
      outcome: { kind: 'discarded' },
      files: {
        ...makeView().files,
        patch: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
      },
    });
    expect(bylineText(view, WIDE)).toBe('Bring the changes back with git apply on the Patch file');
  });

  it('names the Patch row instead of a path a narrow line would cut', () => {
    const view = makeView({
      outcome: { kind: 'discarded' },
      files: {
        ...makeView().files,
        patch: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
      },
    });
    expect(bylineText(view, 56)).toBe('Bring the changes back with git apply on the Patch file');
  });

  it('offers no git apply for a discarded run that saved no changes', () => {
    expect(bylineText(makeView({ outcome: { kind: 'discarded' } }), WIDE)).toBe('');
  });

  // In a real run, one ended run was called cancelled at T005 on the byline and `× Ended` on the
  // closed line. The closed byline names the outcome in the closed line's word.
  it('says an ended workspace run ended and how to bring its changes back', () => {
    const view = endedInBuild();
    expect(
      bylineText(
        {
          ...view,
          files: {
            ...view.files,
            patch: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
          },
        },
        WIDE,
      ),
    ).toBe('Ended · bring the changes back with git apply on the Patch file');
  });

  it('leaves going home to the legend on a completed closed run', () => {
    expect(bylineText(makeView(), WIDE)).toBe('');
  });

  it('points at the blocking findings first', () => {
    const view = makeView({
      outcome: { kind: 'needs-attention' },
      review: {
        kind: 'written',
        verdict: 'fail',
        counts: { critical: 2, warning: 1, note: 0 },
        markdownPath: 'review-packet.md',
        evidence: { validated: 3, total: 3 },
        missingArtifacts: 0,
        preExisting: [],
      },
      scope: { kind: 'checked', passed: false, errors: 1, warnings: 1 },
    });
    expect(bylineText(view, WIDE)).toBe('Read the 2 blocking findings in the packet');
  });

  it('points at the scope deviations when nothing is blocking', () => {
    const view = makeView({
      outcome: { kind: 'needs-attention' },
      scope: { kind: 'checked', passed: false, errors: 1, warnings: 1 },
    });
    expect(bylineText(view, WIDE)).toBe('Check the 2 scope deviations in the packet');
  });

  it('points at the failed briefs when the review and the scope are clean', () => {
    const view = makeView({
      outcome: { kind: 'needs-attention' },
      briefs: {
        total: 3,
        passed: 2,
        failed: 1,
        rows: [],
        earlierRows: [],
      },
    });
    expect(bylineText(view, WIDE)).toBe('Fix the failed brief');
    const two = makeView({
      outcome: { kind: 'needs-attention' },
      briefs: {
        total: 3,
        passed: 1,
        failed: 2,
        rows: [],
        earlierRows: [],
      },
    });
    expect(bylineText(two, WIDE)).toBe('Fix the 2 failed briefs');
  });

  it('leaves going home to the legend when a closed run points at nothing specific', () => {
    const view = makeView({ outcome: { kind: 'needs-attention' }, review: { kind: 'not-run' } });
    expect(bylineText(view, WIDE)).toBe('');
  });

  it('sends an ended run home, because there is nothing left to accept', () => {
    expect(bylineText(endedInBuild(), WIDE)).toBe('Ended · esc home');
  });

  it('reports a decided checkpoint instead of offering one', () => {
    expect(bylineText(makeView({ checkpoint: { kind: 'accepted' } }), WIDE)).toBe(
      'Accepted · nothing left to do',
    );
    expect(bylineText(makeView({ checkpoint: { kind: 'rejected' } }), WIDE)).toBe(
      'Rejected · its files were restored',
    );
  });

  it('truncates the Apply undo command only when it will not fit', () => {
    expect(bylineText(makeView({ outcome: { kind: 'applied' } }), 10)).toHaveLength(10);
  });
});

describe('openRunByline', () => {
  const OPEN = { continuable: true, width: WIDE } as const;

  it('points a run ready to apply at its result menu', () => {
    expect(
      openRunByline({
        continuable: false,
        width: WIDE,
        status: { kind: 'ready-to-apply', override: false },
      }),
    ).toBe('Ready to apply · pick Apply, Show diff or Discard');
  });

  it('says an override is applied as is', () => {
    expect(
      openRunByline({
        continuable: false,
        width: WIDE,
        status: { kind: 'ready-to-apply', override: true },
      }),
    ).toBe('Ready to apply as is · pick Apply as is, Show diff or Discard');
  });

  it('names the brief a paused run is holding, then the key that moves it', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
          resumeAt: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
        },
      }),
    ).toBe('Stopped at T003 · type a correction or ⏎ to continue');
  });

  // UI debt #57: a run parked between briefs reads as the live byline and the transcript row read it.
  it('names the brief a run stopped before when it parked between briefs', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
          resumeAt: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
        },
      }),
    ).toBe('Stopped before T003 · type a correction or ⏎ to continue');
  });

  it('names the review when a run stopped before it at a boundary with no brief left', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
          resumeAt: { kind: 'review', cycle: 0 },
        },
      }),
    ).toBe('Stopped before the review · type a correction or ⏎ to continue');
  });

  it('names the brief an interrupted run resumes without inventing a boundary cut', () => {
    const status: RunStatus = {
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'interrupted' } },
      resumeAt: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
    };
    expect(
      openRunByline({
        ...OPEN,
        status,
      }),
    ).toBe('Stopped at T003 · ⏎ to continue');
  });

  it('gives the same phrase from stopPoint and the at-rest byline for a boundary stop before a brief', () => {
    const step: StepRef = { kind: 'brief', taskId: taskId('T003'), attempt: 0 };
    const phrase = stopPoint(step, 'boundary');
    expect(phrase).toBe('before T003');
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
          resumeAt: step,
        },
      }),
    ).toBe(`Stopped ${phrase} · type a correction or ⏎ to continue`);
  });

  it('gives before the review from stopPoint and the at-rest byline for a boundary stop with no brief left', () => {
    const step: StepRef = { kind: 'review', cycle: 0 };
    const phrase = stopPoint(step, 'boundary');
    expect(phrase).toBe('before the review');
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
          resumeAt: step,
        },
      }),
    ).toBe(`Stopped ${phrase} · type a correction or ⏎ to continue`);
  });

  it('names Apply, not the review, for a run stopped while it applied', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
          resumeAt: { kind: 'apply' },
        },
      }),
    ).toBe('Stopped at Apply · type a correction or ⏎ to continue');
  });

  it('reopens the plan card a run with a typed plan is parked at', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate: 'plan', reopens: true } },
          resumeAt: { kind: 'gate', gate: 'plan' },
        },
      }),
    ).toBe('Waiting at the plan · ⏎ to reopen it');
  });

  it.each(['spec', 'plan', 'briefs'] as const)(
    'continues an old run parked at its %s gate as the plan stage, without reopening it',
    (gate) => {
      expect(
        openRunByline({
          ...OPEN,
          status: {
            kind: 'open',
            stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate, reopens: false } },
            resumeAt: { kind: 'gate', gate },
          },
        }),
      ).toBe('Waiting at the plan · ⏎ to continue');
    },
  );

  it('names a seat-down halt and quotes its headline rather than the raw reason', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: {
            kind: 'waiting-for-you',
            on: {
              kind: 'halt',
              issue: {
                id: 'h1',
                reason: 'runner-unauthenticated',
                phase: 'implementing',
                status: 'awaiting-user',
                files: [],
                affectedTaskIds: [],
                message: 'Signed out',
                details: [],
                facts: { tool: 'codex' },
                availableActions: ['retry-same-worker', 'end-run'],
                recommendedAction: 'retry-same-worker',
                createdAt: '2026-09-14T00:00:00.000Z',
              },
            },
          },
          resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 1 },
        },
      }),
    ).toBe('Seat down · Signed out of codex · ⏎ to decide');
  });

  it('names the tool that refused a brief prompt as too large, not a context overflow', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: {
            kind: 'waiting-for-you',
            on: {
              kind: 'halt',
              issue: makeRecoveryIssue({
                reason: 'context-overflow',
                seat: 'build',
                taskId: taskId('T002'),
                message: 'Prompt too large for OpenCode CLI on T002',
                facts: { tool: 'OpenCode CLI', bytes: 195_203, maxBytes: 120_000 },
                availableActions: ['switch-seat', 'skip-current-task', 'end-run'],
                recommendedAction: 'switch-seat',
              }),
            },
          },
          resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 1 },
        },
      }),
    ).toBe('Seat down · Prompt too large for OpenCode CLI on T002 · ⏎ to decide');
  });

  it('names a halt only the operator can decide as needing you', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue: makeRecoveryIssue() } },
          resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 3 },
        },
      }),
    ).toBe('Needs you · T001 failed · ⏎ to decide');
  });

  it('asks for the answer a run waiting on a question needs', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'waiting-for-you', on: { kind: 'question' } },
          resumeAt: { kind: 'planner', call: 'plan' },
        },
      }),
    ).toBe('Waiting for your answer · type a reply or ⏎ to continue');
  });

  it('quotes the error a failed run recorded', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'failed', message: 'Planning failed.' } },
          resumeAt: { kind: 'planner', call: 'spec' },
        },
      }),
    ).toBe('Stopped by an error · Planning failed. · ⏎ to retry the step');
  });

  it('names the tool a run waits on and the clock its reset lands', () => {
    const resetAt = new Date(new Date().setHours(17, 0, 0, 0)).toISOString();
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: {
            kind: 'stopped',
            on: { kind: 'seat-wait', seat: 'review', tool: 'OpenAI Codex CLI', resetAt },
          },
          resumeAt: { kind: 'review', cycle: 0 },
        },
      }),
    ).toBe('Waiting for OpenAI Codex CLI · resets 17:00');
  });

  it('names the step an interrupted run picks up at', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          resumeAt: { kind: 'planner', call: 'tasks' },
        },
      }),
    ).toBe('Stopped at the plan · ⏎ to continue');
  });

  it('says why a run nothing can pick up cannot be continued', () => {
    expect(
      openRunByline({
        continuable: false,
        width: WIDE,
        status: {
          kind: 'open',
          stop: {
            kind: 'stopped',
            on: { kind: 'failed', message: 'Session has no saved state to read.' },
          },
          resumeAt: { kind: 'planner', call: 'research' },
        },
      }),
    ).toBe('Saved state unreadable · start it again from home');
  });

  it('says a run another process is driving is not this screen to move', () => {
    expect(openRunByline({ ...OPEN, status: { kind: 'running' } })).toBe(
      'Running in another process',
    );
  });

  it('says an Apply is writing to the checkout, with its clock and no key to continue', () => {
    const parts = openRunBylineParts({
      ...OPEN,
      status: { kind: 'running' },
      apply: { elapsedMs: 4_000, queued: null },
    });
    expect(joinedByline(parts)).toBe('Applying to your checkout · 0:04');
    expect(parts[0]).toEqual({ text: 'Applying to your checkout', tone: 'accent' });
  });

  it.each([
    ['home', 6_000, 'Applying to your checkout · Returns home when Apply finishes · 0:06'],
    ['quit', 7_000, 'Applying to your checkout · Quits when Apply finishes · 0:07'],
  ] as const)('says where a queued %s goes once the Apply finishes', (queued, elapsedMs, text) => {
    expect(
      openRunByline({ ...OPEN, status: { kind: 'running' }, apply: { elapsedMs, queued } }),
    ).toBe(text);
  });

  it.each([
    [null, 30, 'Applying to your check… · 0:07'],
    ['quit', 40, 'Quits when Apply finishes · 0:07'],
    ['home', 30, 'Returns home when Appl… · 0:07'],
  ] as const)(
    'keeps the clock on a narrow line and, with %s queued, says where it goes',
    (queued, width, text) => {
      expect(
        openRunByline({
          continuable: false,
          width,
          status: { kind: 'running' },
          apply: { elapsedMs: 7_000, queued },
        }),
      ).toBe(text);
    },
  );

  it('keeps the halt name when a narrow line cannot hold its cause', () => {
    const status: RunStatus = {
      kind: 'open',
      stop: {
        kind: 'waiting-for-you',
        on: {
          kind: 'halt',
          issue: {
            id: 'h1',
            reason: 'implementer-left-isolation',
            phase: 'implementing',
            status: 'awaiting-user',
            files: [],
            affectedTaskIds: [],
            message: 'T002 left the isolation directory',
            details: [],
            availableActions: ['retry-same-worker', 'end-run'],
            recommendedAction: 'retry-same-worker',
            createdAt: '2026-09-14T00:00:00.000Z',
          },
        },
      },
      resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 1 },
    };
    expect(openRunByline({ continuable: true, status, width: 40 })).toBe('Seat down · ⏎ to decide');
  });

  it('sheds the reason before the action when the line will not fit', () => {
    const status = {
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
      resumeAt: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
    } as const;
    expect(openRunByline({ continuable: true, status, width: 30 })).toBe(
      'Type a correction or ⏎ to con…',
    );
  });
});

// A run killed after a recovery action was chosen and before it replayed: ⏎ replays that action.
describe('openRunByline on a halt whose action was chosen', () => {
  function haltByline(issue: RecoveryIssue): string {
    return openRunByline({
      continuable: true,
      width: WIDE,
      status: {
        kind: 'open',
        stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
        resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 1 },
      },
    });
  }

  const SEAT_DOWN = {
    reason: 'runner-unauthenticated',
    phase: 'implementing',
    seat: 'build',
    facts: { tool: 'codex' },
    message: 'Signed out',
  } as const;

  it.each([
    ['Needs you', 'retry-same-worker', 'try again', {}],
    ['Needs you', 'skip-current-task', 'skip task', {}],
    ['Needs you', 'end-run', 'end run', {}],
    ['Needs you', 'continue', 'continue', {}],
    ['Needs you', 'revise', 'fix again', { reason: 'review-failed' }],
    ['Needs you', 'accept-as-is', 'accept as is', { reason: 'review-failed' }],
    ['Needs you', 'accept-as-is', 'skip review with a note', { reason: 'review-input-too-large' }],
    ['Needs you', 'revise', 'send a correction', { reason: 'plan-checks-failed' }],
    ['Needs you', 'retry-same-worker', 're-run Apply', { reason: 'apply-partial' }],
    ['Needs you', 'restore-backup', 'restore backup', { reason: 'apply-partial' }],
    ['Seat down', 'retry-same-worker', 'try again', SEAT_DOWN],
    ['Seat down', 'switch-seat', 'change BUILD tool', SEAT_DOWN],
    ['Seat down', 'retry-later', 'retry later', SEAT_DOWN],
    ['Seat down', 'end-run', 'end run', SEAT_DOWN],
  ] satisfies [string, RecoveryAction, string, Partial<RecoveryIssue>][])(
    '%s halt, chosen %s: ⏎ to %s',
    (halt, selectedAction, label, overrides) => {
      const byline = haltByline(
        makeRecoveryIssue({ ...overrides, status: 'applying', selectedAction }),
      );
      expect(byline.startsWith(`${halt} · `)).toBe(true);
      expect(byline.endsWith(` · ⏎ to ${label}`)).toBe(true);
    },
  );

  it('names a seat-level Try again as its menu row does', () => {
    const issue = makeRecoveryIssue({
      reason: 'planner-call-failed',
      taskId: undefined,
      phase: 'final-review',
      seat: 'review',
      availableActions: ['retry-same-worker', 'end-run'],
      status: 'applying',
      selectedAction: 'retry-same-worker',
    });
    expect(haltByline(issue)).toBe('Seat down · Reviewer call failed · ⏎ to try again');
  });

  it('names a label for every action, so no chosen action reads as a bare "⏎ to"', () => {
    for (const selectedAction of RECOVERY_ACTIONS) {
      const byline = haltByline(makeRecoveryIssue({ status: 'applying', selectedAction }));
      expect(byline).toMatch(/ · ⏎ to [a-z]\S*( \S+)*$/);
      expect(byline.endsWith('⏎ to decide')).toBe(false);
    }
  });

  it('asks the user to decide while no action is chosen', () => {
    expect(haltByline(makeRecoveryIssue())).toBe('Needs you · T001 failed · ⏎ to decide');
    expect(haltByline(makeRecoveryIssue({ status: 'applying' }))).toBe(
      'Needs you · T001 failed · ⏎ to decide',
    );
    expect(
      haltByline(
        makeRecoveryIssue({ status: 'awaiting-user', selectedAction: 'skip-current-task' }),
      ),
    ).toBe('Needs you · T001 failed · ⏎ to decide');
  });

  it('keeps the chosen action when a narrow line sheds the cause', () => {
    const issue = makeRecoveryIssue({ status: 'applying', selectedAction: 'retry-same-worker' });
    const parts = openRunBylineParts({
      continuable: true,
      width: 30,
      status: {
        kind: 'open',
        stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
        resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 1 },
      },
    });
    expect(joinedByline(parts)).toBe('Needs you · ⏎ to try again');
  });
});

describe('legendText', () => {
  it('names the keys the screen answers to', () => {
    expect(legendText({ overflow: false, width: WIDE })).toBe(
      'esc home · ctrl+k commands · /sessions · /help',
    );
  });

  it('adds the scroll key next to esc only when the body overflows', () => {
    expect(legendText({ overflow: true, width: WIDE })).toBe(
      'esc home · shift+↑↓ scroll · ctrl+k commands · /sessions · /help',
    );
  });

  it('drops whole keys rather than half-naming one', () => {
    const fitted = legendText({ overflow: false, width: 30 });
    expect(fitted).toBe('esc home · ctrl+k commands');
    expect(fitted).not.toContain('…');
  });
});

describe('fitted byline parts', () => {
  it.each([
    [{ kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } }, 'Stopped at the plan', 'warning'],
    [
      { kind: 'waiting-for-you', on: { kind: 'gate', gate: 'plan', reopens: true } },
      'Waiting at the plan',
      'warning',
    ],
    [{ kind: 'waiting-for-you', on: { kind: 'question' } }, 'Waiting for your answer', 'warning'],
    [
      { kind: 'stopped', on: { kind: 'failed', message: 'Disk full' } },
      'Stopped by an error · Disk full',
      'error',
    ],
    [{ kind: 'stopped', on: { kind: 'interrupted' } }, 'Stopped at the plan', 'warning'],
    [
      {
        kind: 'stopped',
        on: {
          kind: 'seat-wait',
          seat: 'build',
          tool: 'OpenAI Codex CLI',
          resetAt: '2026-10-10T17:00:00Z',
        },
      },
      'Waiting for OpenAI Codex CLI',
      'warning',
    ],
  ] as const)('keeps %s structured and preserves its joined text', (stop, reason, reasonTone) => {
    const input = {
      status: {
        kind: 'open',
        stop,
        resumeAt: { kind: 'planner', call: 'plan' },
      },
      continuable: true,
      width: WIDE,
    } as const;
    const parts = openRunBylineParts(input);
    expect(parts.slice(0, reason.includes(' · ') ? 3 : 1)).toEqual(
      reason.includes(' · ')
        ? [
            { text: 'Stopped by an error', tone: reasonTone },
            { text: ' · ', tone: 'textDim' },
            { text: 'Disk full', tone: 'text' },
          ]
        : [{ text: reason, tone: reasonTone }],
    );
    expect(joinedByline(parts)).toBe(openRunByline(input));
  });

  it('keeps the halt name before shedding the cause, then keeps the action alone', () => {
    const status: RunStatus = {
      kind: 'open',
      stop: {
        kind: 'waiting-for-you',
        on: {
          kind: 'halt',
          issue: makeRecoveryIssue({
            reason: 'implementer-left-isolation',
            taskId: taskId('T002'),
          }),
        },
      },
      resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 1 },
    };
    expect(openRunBylineParts({ status, continuable: true, width: 40 })).toEqual([
      { text: 'Seat down', tone: 'warning' },
      { text: ' · ', tone: 'textDim' },
      { text: '⏎ to decide', tone: 'textDim' },
    ]);
    expect(openRunBylineParts({ status, continuable: true, width: 12 })).toEqual([
      { text: '⏎ to decide', tone: 'textDim' },
    ]);
  });

  it.each([
    [{ kind: 'ready-to-apply', override: false }, 'accent'],
    [{ kind: 'ready-to-apply', override: true }, 'warning'],
    [{ kind: 'running' }, 'accent'],
  ] as const)('colors %s from its state', (status, reasonTone) => {
    expect(openRunBylineParts({ status, continuable: true, width: WIDE })[0]).toEqual({
      text:
        status.kind === 'running'
          ? 'Running in another process'
          : status.override
            ? 'Ready to apply as is'
            : 'Ready to apply',
      tone: reasonTone,
    });
  });

  it.each([
    ['accepted', 'Accepted', 'success'],
    ['rejected', 'Rejected', 'warning'],
  ] as const)(
    'keeps the %s state separate from its dim action',
    (checkpoint, reason, reasonTone) => {
      const view = makeView({ checkpoint: { kind: checkpoint } });
      const parts = bylineParts(view, WIDE);
      expect(parts.slice(0, reason.includes(' · ') ? 3 : 1)).toEqual(
        reason.includes(' · ')
          ? [
              { text: 'Stopped by an error', tone: reasonTone },
              { text: ' · ', tone: 'textDim' },
              { text: 'Disk full', tone: 'text' },
            ]
          : [{ text: reason, tone: reasonTone }],
      );
      expect(joinedByline(parts)).toBe(bylineText(view, WIDE));
    },
  );
});

it('keeps status receipt text and fitting while coloring Apply undone and Ended', () => {
  const undone = makeView({ applyUndo: { conflicts: [] } });
  expect(bylineParts(undone, WIDE)[0]).toEqual({ text: 'Apply undone', tone: 'warning' });
  expect(bylineParts(endedInBuild(), WIDE)[0]).toEqual({ text: 'Ended', tone: 'warning' });
  for (const [width, expected, expectedParts] of [
    [5, 'Appl…', [{ text: 'Appl…', tone: 'warning' }]],
    [11, 'Apply undo…', [{ text: 'Apply undo…', tone: 'warning' }]],
    [12, 'Apply undon…', [{ text: 'Apply undon…', tone: 'warning' }]],
    [
      13,
      'Apply undone…',
      [
        { text: 'Apply undone', tone: 'warning' },
        { text: '…', tone: 'textDim' },
      ],
    ],
    [
      14,
      'Apply undone …',
      [
        { text: 'Apply undone', tone: 'warning' },
        { text: ' …', tone: 'textDim' },
      ],
    ],
    [
      15,
      'Apply undone ·…',
      [
        { text: 'Apply undone', tone: 'warning' },
        { text: ' ·…', tone: 'textDim' },
      ],
    ],
    [
      16,
      'Apply undone · …',
      [
        { text: 'Apply undone', tone: 'warning' },
        { text: ' · ', tone: 'textDim' },
        { text: '…', tone: 'textDim' },
      ],
    ],
    [
      20,
      'Apply undone · noth…',
      [
        { text: 'Apply undone', tone: 'warning' },
        { text: ' · ', tone: 'textDim' },
        { text: 'noth…', tone: 'textDim' },
      ],
    ],
    [
      WIDE,
      'Apply undone · nothing left to undo',
      [
        { text: 'Apply undone', tone: 'warning' },
        { text: ' · ', tone: 'textDim' },
        { text: 'nothing left to undo', tone: 'textDim' },
      ],
    ],
  ] as const) {
    const parts = bylineParts(undone, width);
    expect(joinedByline(parts)).toBe(expected);
    expect(bylineText(undone, width)).toBe(expected);
    expect(parts).toEqual(expectedParts);
  }
});

it('keeps the separator inside a failed reason dim', () => {
  const parts = openRunBylineParts({
    status: {
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'failed', message: 'Disk full' } },
      resumeAt: { kind: 'planner', call: 'plan' },
    },
    continuable: true,
    width: WIDE,
  });
  expect(parts).toEqual([
    { text: 'Stopped by an error', tone: 'error' },
    { text: ' · ', tone: 'textDim' },
    { text: 'Disk full', tone: 'text' },
    { text: ' · ', tone: 'textDim' },
    { text: '⏎ to retry the step', tone: 'textDim' },
  ]);
});

it('keeps the review seat in an at-rest halt title', () => {
  const issue = makeRecoveryIssue({ reason: 'planner-call-failed', seat: 'review' });
  const parts = openRunBylineParts({
    status: {
      kind: 'open',
      stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
      resumeAt: { kind: 'review', cycle: 0 },
    },
    continuable: true,
    width: WIDE,
  });
  expect(joinedByline(parts)).toBe('Seat down · Reviewer call failed · ⏎ to decide');
  expect(parts).toEqual([
    { text: 'Seat down', tone: 'warning' },
    { text: ' · ', tone: 'textDim' },
    { text: 'Reviewer', tone: 'reviewer' },
    { text: ' call failed', tone: 'text' },
    { text: ' · ', tone: 'textDim' },
    { text: '⏎ to decide', tone: 'textDim' },
  ]);
});
