import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../../../core/state/machine.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import type { PacketEvent } from './types.js';
import { makeRecoveryWithSources } from './recovery.js';

const switched: PacketEvent = {
  type: 'seat_switched',
  ts: '2026-10-10T12:57:12.126Z',
  phase: 'implementing',
  seat: 'build',
  from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
  to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
  cause: 'runner-usage-limit',
  accountCause: 'balance',
  headline: 'Balance spent on OpenCode CLI',
  auto: true,
  configRevision: 'revision',
};
const state: WorkflowState = {
  ...createInitialState('feat'),
  seatSwitches: [
    {
      seat: 'build',
      from: 'OpenCode CLI · deepseek/deepseek-flash',
      to: 'OpenCode CLI · opencode-go/deepseek-v4.1-flash · high',
      cause: 'runner-usage-limit',
      accountCause: 'balance',
      headline: 'Balance spent on OpenCode CLI',
      auto: true,
      configRevision: 'revision',
      ts: switched.ts,
    },
  ],
};

function recoveryFor(events: PacketEvent[], saved = state, missing: string[] = []) {
  return makeRecoveryWithSources({
    projectDir: '/tmp/packet-recovery',
    sessionId: 's',
    state: saved,
    events,
    ledger: null,
    missing,
  });
}

describe('packet recovery evidence', () => {
  it('includes an automatic seat switch in recovery evidence', () => {
    const recovery = recoveryFor([
      {
        type: 'recovery_prompted',
        ts: '2026-10-10T12:57:09.795Z',
        issueId: 'rec_balance',
        reason: 'runner-usage-limit',
        headline: 'Balance spent on OpenCode CLI',
        message: 'Balance spent on OpenCode CLI',
      },
      switched,
      {
        type: 'recovery_resolved',
        ts: '2026-10-10T12:57:12.127Z',
        issueId: 'rec_balance',
        action: 'switch-seat',
        outcome: 'retry-current-task',
      },
    ]);

    expect(recovery.events.map((event) => event.type)).toContain('seat_switched');
    expect(recovery.outcomes[0]?.message).toBe('Balance spent on OpenCode CLI');
    expect(recovery.events.filter((event) => event.type === 'seat_switched')).toHaveLength(1);
    expect(recovery.events.find((event) => event.type === 'seat_switched')?.from).toEqual(
      switched.from,
    );
  });

  it('uses the saved switch when the event log is missing', () => {
    const recovery = recoveryFor([], state, ['session.jsonl']);

    expect(recovery.events).toHaveLength(1);
    expect(recovery.events[0]).toMatchObject({ ...state.seatSwitches?.[0], type: 'seat_switched' });
    expect(recovery.unresolvedRisks).toContain(
      'Recovery events are unavailable because session.jsonl is missing.',
    );
  });

  it('keeps both saved switches when only the later switch is logged with empty revisions', () => {
    const first = {
      seat: 'build',
      from: 'OpenAI Codex CLI · GPT-5',
      to: 'OpenCode CLI · DeepSeek V4.1 Flash · high',
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: '',
      ts: switched.ts,
    } as const;
    const second = {
      ...first,
      from: first.to,
      to: 'Cursor Agent CLI · Claude Opus 5 · thinking',
      ts: '2026-10-10T12:58:12.126Z',
    };
    const logged: PacketEvent = {
      ...second,
      type: 'seat_switched',
      from: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      to: { tool: 'cursor', model: 'claude-opus-5-thinking' },
    };
    const recovery = recoveryFor([logged], { ...state, seatSwitches: [first, second] });

    expect(recovery.events).toEqual([logged, { type: 'seat_switched', ...first }]);
  });

  it('consumes each logged switch only once when saved identities repeat', () => {
    const record = state.seatSwitches?.[0];
    if (record === undefined) throw new Error('Missing saved switch fixture');
    const recovery = recoveryFor([switched], {
      ...state,
      seatSwitches: [record, { ...record, ts: '2026-10-10T12:58:12.126Z' }],
    });

    expect(recovery.events).toEqual([
      switched,
      { type: 'seat_switched', ...record, ts: '2026-10-10T12:58:12.126Z' },
    ]);
  });

  it('keeps a legacy saved switch broad without inferring an account cause', () => {
    const recovery = recoveryFor([], {
      ...state,
      seatSwitches: [
        {
          seat: 'build',
          from: 'old',
          to: 'new',
          cause: 'runner-usage-limit',
          auto: true,
          configRevision: 'revision',
          ts: switched.ts,
        },
      ],
    });

    expect(recovery.events[0]?.cause).toBe('runner-usage-limit');
    expect(recovery.events[0]?.accountCause).toBeUndefined();
    expect(recovery.events[0]?.headline).toBeUndefined();
  });
});
