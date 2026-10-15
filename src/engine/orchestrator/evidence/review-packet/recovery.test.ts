import { describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { formatSeatChangeIdentities } from '../../../../core/crew/identity.js';
import { ensureSessionDir } from '../../../../core/paths-io.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { loadState, saveState } from '../../../../core/state/persistence.js';
import type { SeatSwitchRecord, WorkflowState } from '../../../../core/schemas/workflow.js';
import { createJsonlSink } from '../../../events/sinks/jsonl.js';
import type { PacketEvent } from './types.js';
import { buildReviewPacket } from './build.js';
import { makeRecoveryWithSources } from './recovery.js';
import { renderReviewPacketMarkdown } from './render.js';
import { NULL_CACHE } from '../../../providers/model/resolution.js';

const switched: PacketEvent = {
  type: 'seat_switched',
  switchId: 'b8b5c54f-97b8-47e0-8d19-30f7e671c972',
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
      switchId: switched.switchId,
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
const legacySwitch: SeatSwitchRecord = {
  seat: 'build',
  from: 'OpenCode CLI · DeepSeek V4.1 Flash',
  to: 'Claude Code CLI · Sonnet 5',
  cause: 'runner-usage-limit',
  auto: true,
  configRevision: 'revision',
  ts: '2026-10-10T12:57:12.125Z',
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
  it.each([
    {
      name: 'reversed Codex models',
      savedFrom: { tool: 'codex', model: 'gpt-5.1' },
      savedTo: { tool: 'codex', model: 'gpt-5.1-codex' },
      loggedFrom: { tool: 'codex', model: 'gpt-5.1-codex' },
      loggedTo: { tool: 'codex', model: 'gpt-5.1' },
    },
    {
      name: 'Claude context windows',
      savedFrom: { tool: 'claude-code', model: 'sonnet' },
      savedTo: { tool: 'claude-code', model: 'opus' },
      loggedFrom: { tool: 'claude-code', model: 'sonnet[1m]' },
      loggedTo: { tool: 'claude-code', model: 'opus[1m]' },
    },
    {
      name: 'OpenCode routes',
      savedFrom: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      savedTo: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
      loggedFrom: { tool: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' },
      loggedTo: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
    },
    {
      name: 'different Flash models',
      savedFrom: { tool: 'opencode', model: 'google/gemini-3.8-flash' },
      savedTo: { tool: 'opencode', model: 'openrouter/google/gemini-3.8-flash' },
      loggedFrom: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      loggedTo: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
    },
    {
      name: 'Cursor effort, thinking and fast settings',
      savedFrom: { tool: 'cursor', model: 'claude-opus-5-high' },
      savedTo: { tool: 'cursor', model: 'claude-sonnet-5-high' },
      loggedFrom: { tool: 'cursor', model: 'claude-opus-5-thinking-xhigh-fast' },
      loggedTo: { tool: 'cursor', model: 'claude-sonnet-5-thinking-xhigh-fast' },
    },
  ])(
    'keeps both rows for $name without switch ids',
    ({ savedFrom, savedTo, loggedFrom, loggedTo }) => {
      const record: SeatSwitchRecord = {
        ...legacySwitch,
        ...formatSeatChangeIdentities(savedFrom, savedTo),
        auto: false,
        configRevision: '',
        ts: '2026-10-10T12:57:10.000Z',
      };
      const logged: PacketEvent = {
        type: 'seat_switched',
        ...record,
        from: loggedFrom,
        to: loggedTo,
        ts: '2026-10-10T12:57:11.005Z',
      };

      expect(recoveryFor([logged], { ...state, seatSwitches: [record] }).events).toEqual([
        { type: 'seat_switched', ...record },
        logged,
      ]);
    },
  );

  it('includes a legacy switch when no matching event is logged', () => {
    expect(recoveryFor([], { ...state, seatSwitches: [legacySwitch] }).events).toEqual([
      { type: 'seat_switched', ...legacySwitch },
    ]);
  });

  it.each([undefined, 'another-switch'])(
    'keeps identical saved and logged switches separate with saved id %s',
    (switchId) => {
      const record = state.seatSwitches?.[0];
      if (record === undefined) throw new Error('Missing saved switch fixture');
      const saved = { ...record, switchId };

      expect(recoveryFor([switched], { ...state, seatSwitches: [saved] }).events).toEqual([
        switched,
        { type: 'seat_switched', ...saved },
      ]);
    },
  );

  it('keeps an identified saved switch when the matching log has no id', () => {
    const logged = { ...switched, switchId: undefined };
    expect(recoveryFor([logged]).events).toEqual([
      logged,
      { type: 'seat_switched', ...state.seatSwitches?.[0] },
    ]);
  });

  it('keeps identical legacy saved and logged switches as separate rows', () => {
    const logged = { type: 'seat_switched', ...legacySwitch };
    expect(recoveryFor([logged], { ...state, seatSwitches: [legacySwitch] }).events).toEqual([
      logged,
      { type: 'seat_switched', ...legacySwitch },
    ]);
  });

  it('joins by switch id despite renamed labels and unequal timestamps and recovers routes without a log', () => {
    const record = state.seatSwitches?.[0];
    if (
      record === undefined ||
      typeof switched.from !== 'object' ||
      typeof switched.to !== 'object'
    )
      throw new Error('Missing routed switch fixture');
    const saved: WorkflowState = {
      ...state,
      seatSwitches: [
        {
          ...record,
          from: 'renamed source',
          to: 'renamed destination',
          fromSeat: switched.from,
          toSeat: switched.to,
          ts: '2026-10-10T12:57:12.125Z',
        },
      ],
    };
    expect(recoveryFor([switched], saved).events).toEqual([switched]);
    expect(recoveryFor([], saved).events[0]).toMatchObject({
      from: switched.from,
      to: switched.to,
    });
  });
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

  it('builds and renders an id-joined switch once alongside an unlogged legacy switch', async () => {
    const projectDir = createTempDir('packet-legacy-switches');
    const ref = { projectDir, sessionId: 'legacy-switches' };
    try {
      ensureSessionDir(projectDir, ref.sessionId);
      const first = { ...legacySwitch, auto: false, configRevision: '' };
      const second = {
        ...first,
        switchId: '9a95bfc7-886b-4df1-b909-109811d51637',
        from: first.to,
        to: first.from,
        ts: '2026-10-10T12:58:12.125Z',
      };
      saveState(ref, {
        ...createInitialState('feat', new Date(first.ts)),
        phase: 'implementing',
        seatSwitches: [first, second],
      });
      createJsonlSink(ref)({
        type: 'seat_switched',
        switchId: second.switchId,
        ts: Date.parse(second.ts) + 1,
        phase: 'implementing',
        seat: 'build',
        from: { tool: 'claude-code', model: 'sonnet' },
        to: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        cause: second.cause,
        auto: second.auto,
        configRevision: second.configRevision,
      });
      const saved = loadState(ref);
      if (saved === null) throw new Error('Missing saved legacy switches');
      const packet = await buildReviewPacket({
        ...ref,
        workspaceDir: ref.projectDir,
        state: saved,
        summary: makeSummary(),
        finalReviewStatus: 'failed',
      });

      expect(packet.recoveryDecisions.events).toEqual([
        { type: 'seat_switched', ...first },
        expect.objectContaining({
          type: 'seat_switched',
          switchId: second.switchId,
          ts: '2026-10-10T12:58:12.126Z',
          from: { tool: 'claude-code', model: 'sonnet' },
          to: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
      ]);
      const rows = renderReviewPacketMarkdown(packet, NULL_CACHE)
        .split('\n')
        .filter((line) => line.startsWith('- BUILD switched'));
      expect(rows).toEqual([
        `- BUILD switched manually: ${first.from} → ${first.to}; usage limit`,
        '- BUILD switched manually: Claude Code CLI · Sonnet 5.5 → OpenCode CLI · DeepSeek V4.1 Flash · via deepseek; usage limit',
      ]);
    } finally {
      cleanupTempDir(projectDir);
    }
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
