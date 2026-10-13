import { beforeEach, expect, it } from 'vitest';
import { createElement, Fragment } from 'react';
import { renderFeature } from '#testing/helpers/ink.js';
import {
  makeRunnerCallActivity,
  makeRunnerCallStarted,
} from '#testing/helpers/events/runner-call.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { ConversationRowView } from '../components/conversation-flow/row-view.js';
import { projectRunnerCallEvents } from '../../../engine/calls/event-projection.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { getSections } from '../../../stores/workflow/actions/sections.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { deriveLiveStatus } from '../display/live-activity.js';
import type { EngineEvent } from '../../../engine/events/types.js';

beforeEach(resetWorkflow);

function transcript(events: EngineEvent[]): string {
  for (const event of events) addEvent(event);
  const { rows } = buildConversationRows({
    sections: getSections(),
    expandedDiffs: new Set(),
    expandedActivityBatches: new Set(),
    cols: 120,
    viewportHeight: 100,
    streaming: { taskId: null, lines: [], active: false },
  });
  const view = renderFeature(
    createElement(
      Fragment,
      null,
      ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
    ),
  );
  const frame = view.lastFrame();
  view.unmount();
  return frame;
}

it('shows four BUILD tool uses once each and hides protocol answers', () => {
  const events: EngineEvent[] = [];
  for (const [index, name] of ['Read', 'Read', 'Edit', 'Edit', 'StructuredOutput'].entries()) {
    const context = {
      callId: 'run:build:unique',
      role: 'implementer' as const,
      backendKind: 'cli' as const,
      channel: 'tool' as const,
      ts: index,
    };
    const opts = { phase: 'implementing' as const, rootDir: '/project', sequence: index };
    events.push(
      ...projectRunnerCallEvents(
        {
          ...context,
          type: 'call_tool_use_delta',
          toolUseId: `tool-${index}`,
          name,
          inputDelta: '',
        },
        opts,
      ),
    );
    events.push(
      ...projectRunnerCallEvents(
        {
          ...context,
          type: 'call_tool_use_done',
          toolUse: {
            id: `tool-${index}`,
            name,
            input:
              name === 'StructuredOutput'
                ? {}
                : { file_path: index % 2 ? 'src/math.test.js' : 'src/math.js' },
          },
        },
        opts,
      ),
    );
  }
  const frame = transcript(events);
  expect(frame).toContain('BUILD activity  4 updates');
  expect(frame).not.toContain('tool Read');
  expect(frame).not.toContain('tool Edit');
  expect(frame).not.toContain('StructuredOutput');
});

it('keeps interrupted and resumed reviews separate and puts each result after its checks', () => {
  const check = (ts: number): EngineEvent => ({
    type: 'full_suite',
    ts,
    phase: 'final-review',
    status: 'done',
    moment: 'plan',
    id: 'K1',
    command: 'node --version',
    passed: true,
    duration: 250,
  });
  const start = (ts: number): EngineEvent => ({
    type: 'review_started',
    ts,
    phase: 'final-review',
    scope: 'final',
    tool: 'claude-code',
    model: 'sonnet',
  });
  const frame = transcript([
    check(1_000),
    start(1_250),
    makeRunnerCallActivity({
      ts: 4_000,
      phase: 'final-review',
      role: 'review',
      callId: 'first',
      activityId: 'first:terminal',
      kind: 'error',
      stage: 'aborted',
      label: 'aborted runner_interrupted',
      diagnosticPartial: 'SPLITBRIEF exited',
    }),
    { type: 'workflow_resumed', ts: 100_000, phase: 'final-review' },
    check(100_250),
    start(100_500),
    {
      type: 'review_completed',
      ts: 119_500,
      phase: 'final-review',
      scope: 'final',
      tool: 'claude-code',
      verdict: 'pass',
      duration: 19_000,
    },
  ]);
  expect(frame).toContain('Final review stopped');
  expect(frame).toContain('2.8s');
  expect(frame).toContain('Run continued');
  expect(frame).toContain('Final review re-run passed');
  expect(frame).toContain('19.0s');
  const firstCheck = frame.indexOf('Plan check K1');
  const stop = frame.indexOf('Final review stopped');
  const resume = frame.indexOf('Run continued');
  const secondCheck = frame.indexOf('Plan check K1', firstCheck + 1);
  expect(firstCheck).toBeLessThan(stop);
  expect(stop).toBeLessThan(resume);
  expect(resume).toBeLessThan(secondCheck);
  expect(secondCheck).toBeLessThan(frame.indexOf('Final review re-run passed'));
});

it('hides a saved protocol call without splitting the surrounding activity', () => {
  const activity = (activityId: string, kind: 'read' | 'unknown', label: string) =>
    makeRunnerCallActivity({
      callId: 'review:older',
      activityId,
      phase: 'final-review',
      role: 'review',
      kind,
      label,
    });
  const frame = transcript([
    activity('read-1', 'read', 'reading src/math.js'),
    activity('answer', 'unknown', 'tool StructuredOutput'),
    activity('read-2', 'read', 'reading src/math.test.js'),
  ]);
  expect(frame).not.toContain('StructuredOutput');
  expect(frame.match(/REVIEW activity/g)).toHaveLength(1);
  expect(frame).toContain('2 updates');
});

it('keeps the brief name on an interrupted task review', () => {
  const frame = transcript([
    {
      type: 'review_started',
      ts: 1_000,
      phase: 'implementing',
      scope: 'task',
      afterTaskId: 'T001',
      tool: 'claude-code',
    },
    makeRunnerCallActivity({
      ts: 4_000,
      phase: 'implementing',
      role: 'review',
      kind: 'error',
      stage: 'aborted',
      label: 'aborted runner_interrupted',
      diagnosticPartial: 'SPLITBRIEF exited',
    }),
  ]);
  expect(frame).toContain('Review T001 stopped');
  expect(frame).not.toContain('Final review');
});

it('names check selection before the verdict and keeps the same step through call gaps', () => {
  addEvent({
    type: 'review_started',
    ts: 1_000,
    phase: 'final-review',
    scope: 'final',
    tool: 'claude-code',
  });
  addEvent({ type: 'review_step', ts: 1_000, phase: 'final-review', step: 'choosing-checks' });
  addEvent(makeRunnerCallStarted({ ts: 1_100, phase: 'final-review', role: 'review' }));
  const text = () =>
    deriveLiveStatus({
      phase: 'final-review',
      status: 'running',
      cancelled: false,
      startedAt: 1_000,
      phaseFirstSeenTs: {},
      waitedMs: {},
      resumedAt: null,
      reviewerLabel: null,
      plannerCall: null,
      plannerCallStartedTs: null,
      suiteStage: null,
      activeOperation: operationsStore.get().active,
    })
      ?.parts.map((part) => part.text)
      .join('');
  expect(text()).toContain('choosing checks');
  expect(text()).not.toContain('waiting for the verdict');
  addEvent({
    type: 'review_checks',
    ts: 2_000,
    phase: 'final-review',
    scope: 'final',
    status: 'planned',
    commands: [],
    declined: [],
    reason: 'No commands needed.',
  });
  expect(text()).toContain('reviewing changes');
});
