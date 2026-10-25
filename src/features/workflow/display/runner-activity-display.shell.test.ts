import { describe, expect, it } from 'vitest';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { buildActivityBatchViewModel } from '../conversation-rows/activity-batch-model.js';
import { runnerActivityLedgerItem } from './runner-activity-display.js';

type ActivityEvent = EngineEventOf<'runner_call_activity'>;
type VisibleActivityKind = Exclude<ActivityEvent['kind'], 'session'>;

function activity(
  overrides: Partial<Omit<ActivityEvent, 'kind'>> & {
    kind?: VisibleActivityKind;
  },
): ActivityEvent & { kind: VisibleActivityKind } {
  const kind = overrides.kind ?? 'unknown';
  return {
    type: 'runner_call_activity',
    ts: overrides.ts ?? 0,
    phase: overrides.phase ?? 'researching',
    callId: overrides.callId ?? 'call-1',
    role: overrides.role ?? 'planner',
    backendKind: overrides.backendKind ?? 'cli',
    runnerName: overrides.runnerName ?? 'codex',
    sequence: overrides.sequence ?? 1,
    activityId: overrides.activityId ?? `${overrides.kind}:${overrides.label}`,
    stage: overrides.stage ?? 'updated',
    kind,
    label: overrides.label ?? 'checking project',
    redacted: overrides.redacted ?? false,
    ...(overrides.target !== undefined && { target: overrides.target }),
    ...(overrides.model !== undefined && { model: overrides.model }),
    ...(overrides.axes !== undefined && { axes: overrides.axes }),
    ...(overrides.taskId !== undefined && { taskId: overrides.taskId }),
    ...(overrides.attempt !== undefined && { attempt: overrides.attempt }),
    ...(overrides.textPartial !== undefined && { textPartial: overrides.textPartial }),
    ...(overrides.diagnosticPartial !== undefined && {
      diagnosticPartial: overrides.diagnosticPartial,
    }),
    ...(overrides.rawAvailable !== undefined && { rawAvailable: overrides.rawAvailable }),
  };
}

const ROLES: readonly EngineEventOf<'runner_call_activity'>['role'][] = [
  'planner',
  'implementer',
  'review',
];

describe('shell tool activity with and without command', () => {
  it.each(ROLES)('omits commandless shell calls from rows and counts for %s', (role) => {
    const phase =
      role === 'planner' ? 'planning' : role === 'implementer' ? 'implementing' : 'final-review';

    const withCommand = activity({
      role,
      phase,
      sequence: 1,
      kind: 'command',
      stage: 'started',
      label: 'running git diff',
      target: 'git diff',
    });

    const commandWithoutTarget = activity({
      role,
      phase,
      sequence: 2,
      kind: 'command',
      stage: 'started',
      label: 'running command',
    });

    const bashWithoutDetail = activity({
      role,
      phase,
      sequence: 3,
      kind: 'tool',
      stage: 'started',
      label: 'tool Bash',
    });

    const shellWithoutDetail = activity({
      role,
      phase,
      sequence: 4,
      kind: 'tool',
      stage: 'started',
      label: 'tool Shell',
    });

    expect(runnerActivityLedgerItem(commandWithoutTarget)).toBeNull();
    expect(runnerActivityLedgerItem(bashWithoutDetail)).toBeNull();
    expect(runnerActivityLedgerItem(shellWithoutDetail)).toBeNull();

    const item = runnerActivityLedgerItem(withCommand);
    expect(item).not.toBeNull();
    expect(item?.value).toBe('git diff');

    const events = [commandWithoutTarget, withCommand, bashWithoutDetail, shellWithoutDetail];

    const collapsed = buildActivityBatchViewModel({
      batchKey: `${role}-batch`,
      events,
    });
    expect(collapsed.headerCount).toBe(1);
    expect(collapsed.visibleItems).toHaveLength(1);
    expect(collapsed.visibleItems[0]?.value).toBe('git diff');

    const expanded = buildActivityBatchViewModel({
      batchKey: `${role}-batch`,
      events,
      expanded: true,
    });
    expect(expanded.headerCount).toBe(1);
    expect(expanded.visibleItems).toHaveLength(1);
    expect(expanded.visibleItems[0]?.value).toBe('git diff');

    const onlyCommandless = buildActivityBatchViewModel({
      batchKey: `${role}-only-commandless`,
      events: [commandWithoutTarget, bashWithoutDetail, shellWithoutDetail],
    });
    expect(onlyCommandless.headerCount).toBe(0);
    expect(onlyCommandless.visibleItems).toHaveLength(0);
  });
});
