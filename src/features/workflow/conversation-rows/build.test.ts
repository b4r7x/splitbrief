import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { eventsStore, mergeEventLog } from '../../../stores/workflow/events.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement, Fragment } from 'react';
import { ConversationRowView } from '../components/conversation-flow/row-view.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { groupEventsIntoSections, type Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { makePlannerHeartbeat, makePlannerStatus } from '#testing/helpers/events/planner.js';
import {
  makeRunnerCallActivity,
  makeRunnerCallCompleted,
  makeRunnerCallError,
  makeRunnerCallStarted,
} from '#testing/helpers/events/runner-call.js';
import {
  makeTaskComplete,
  makeTaskSkipped,
  makeTaskStart,
  makeTaskTokens,
} from '#testing/helpers/events/task.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from '../display/activity-label-display.js';
import { runnerActivityModelRole } from '../display/runner-activity-display.js';
import { activityBatchKey } from './activity-batch-key.js';
import { resetEventBlockCache } from './block-cache.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { buildConversationRowsProjection } from './build.js';
import { buildConversationRowActions } from './row-actions.js';
import { EngineEventSchema } from '../../../engine/events/schema.js';
import { materializeConversationRowsWindow } from './materialize-window.js';
import { computeConversationRowsWindowFromProjection } from './scroll.js';
import { wrappedTextBlock } from './row-block-compose.js';
import { rowText } from './row-format/rows.js';
import { wrapWidthFor } from './row-markers.js';
import type { ConversationRow } from './types.js';
import { taskId } from '../../../core/schemas/task.js';
import { arrowSep, SOFT_SEP } from '../../../core/separators.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
import { buildCheckoutChangedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };
const CODEX_LABEL = 'OpenAI Codex CLI';
describe('automatic recovery from the spent-balance smoke', () => {
  const events: EngineEvent[] = [
    {
      type: 'runner_call_started',
      ts: 1791727000961,
      taskId: 'T001',
      phase: 'implementing',
      callId: 'implementer-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
      model: 'deepseek/deepseek-flash',
      axes: [],
      attempt: 0,
      usageBoundary: 'aggregate',
      sequence: 415,
    },
    {
      type: 'steerable_call',
      ts: 1791727003321,
      taskId: 'T001',
      phase: 'implementing',
      seat: 'build',
    },
    {
      type: 'runner_call_session_id',
      ts: 1791727003323,
      taskId: 'T001',
      phase: 'implementing',
      callId: 'implementer-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
      model: 'deepseek/deepseek-flash',
      axes: [],
      attempt: 0,
      usageBoundary: 'aggregate',
      sequence: 416,
      nativeSessionId: 'ses_ed4bf9e1dffehEzin1mygGWRGs',
    },
    {
      type: 'runner_call_warning',
      ts: 1791727003353,
      taskId: 'T001',
      phase: 'implementing',
      callId: 'implementer-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
      model: 'deepseek/deepseek-flash',
      axes: [],
      attempt: 0,
      usageBoundary: 'aggregate',
      sequence: 417,
      warning: {
        code: 'opencode-error',
        severity: 'warning',
        source: 'provider',
        surface: 'activity',
        fingerprint: 'rw:763c296f02a6f316bfc6ef84',
        message:
          'provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)',
      },
    },
    {
      type: 'runner_call_activity',
      ts: 1791727003353,
      taskId: 'T001',
      phase: 'implementing',
      callId: 'implementer-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
      model: 'deepseek/deepseek-flash',
      axes: [],
      attempt: 0,
      usageBoundary: 'aggregate',
      sequence: 417,
      activityId: 'implementer-1:warning:rw:763c296f02a6f316bfc6ef84',
      stage: 'warning',
      kind: 'warning',
      label: 'warning opencode-error',
      redacted: false,
      rawAvailable: false,
      expandId: 'implementer-1:warning:rw:763c296f02a6f316bfc6ef84',
      diagnosticPartial:
        'provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)',
    },
    {
      type: 'steerable_call',
      ts: 1791727003363,
      phase: 'implementing',
    },
    {
      type: 'runner_call_error',
      ts: 1791727003410,
      taskId: 'T001',
      phase: 'implementing',
      callId: 'implementer-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
      model: 'deepseek/deepseek-flash',
      axes: [],
      attempt: 0,
      usageBoundary: 'aggregate',
      sequence: 418,
      status: 'failed',
      error: {
        code: 'opencode-error',
        message:
          'provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)',
        status: 402,
        providerType: 'provider.quota',
      },
      partial: true,
      rawTail:
        'provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)',
      startedAt: 1791727000961,
      endedAt: 1791727003410,
      durationMs: 2449,
      usage: null,
      nativeSessionId: 'ses_ed4bf9e1dffehEzin1mygGWRGs',
    },
    {
      type: 'runner_call_activity',
      ts: 1791727003410,
      taskId: 'T001',
      phase: 'implementing',
      callId: 'implementer-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
      model: 'deepseek/deepseek-flash',
      axes: [],
      attempt: 0,
      usageBoundary: 'aggregate',
      sequence: 418,
      activityId: 'implementer-1:terminal',
      stage: 'failed',
      kind: 'error',
      label: 'failed opencode-error',
      redacted: false,
      rawAvailable: true,
      expandId: 'implementer-1:terminal',
      diagnosticPartial:
        'provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)',
    },
    {
      type: 'implementer_generate_failed',
      ts: 1791727003462,
      taskId: 'T001',
      phase: 'implementing',
      model: 'deepseek/deepseek-flash',
      error:
        'provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)',
    },
    {
      type: 'error',
      ts: 1791727003480,
      phase: 'implementing',
      message:
        'Balance spent on OpenCode CLI. Add credit or change the BUILD tool, then continue. (runner reported: provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569))',
    },
    {
      type: 'recovery_prompted',
      ts: 1791727003524,
      taskId: 'T001',
      phase: 'implementing',
      issueId: 'rec_20261011135643_runner_usage_limit_implementing_T001',
      reason: 'runner-usage-limit',
      files: ['src/text.js'],
      affectedTaskIds: ['T001'],
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      headline: 'Balance spent on OpenCode CLI',
      headlineSpans: [
        {
          text: 'Balance spent on OpenCode CLI',
        },
      ],
      resumeCommand:
        'splitbrief continue 2026-10-11-word-counts-and-marked-previews --action switch-seat:opencode:opencode-go/deepseek-v4.1-flash@high',
    },
    {
      type: 'recovery_action_selected',
      ts: 1791727007504,
      phase: 'implementing',
      issueId: 'rec_20261011135643_runner_usage_limit_implementing_T001',
      reason: 'runner-usage-limit',
      action: 'switch-seat',
      seat: 'build',
    },
    {
      type: 'seat_switched',
      ts: 1791727007552,
      phase: 'implementing',
      seat: 'build',
      from: {
        tool: 'opencode',
        model: 'deepseek/deepseek-flash',
      },
      to: {
        tool: 'opencode',
        model: 'opencode-go/deepseek-v4.1-flash',
        variant: 'high',
      },
      cause: 'runner-usage-limit',
      accountCause: 'balance',
      headline: 'Balance spent on OpenCode CLI',
      auto: true,
      configRevision: '643fca0d8c759fc0e3b5b4957fe3e290aaa87a3e309ec98100fa7cfca9db4aa7',
    },
    {
      type: 'recovery_resolved',
      ts: 1791727007552,
      phase: 'implementing',
      issueId: 'rec_20261011135643_runner_usage_limit_implementing_T001',
      reason: 'runner-usage-limit',
      action: 'switch-seat',
      seat: 'build',
      outcome: 'retry-current-task',
      implementerProfile: 'default',
    },
  ].map((event) => EngineEventSchema.parse(event));
  const words =
    'provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)';

  const resumedEvents = [
    {
      type: 'warning',
      ts: 1791727007579,
      phase: 'implementing',
      message:
        'BUILD seat changed OpenCode CLI \u00b7 DeepSeek V4.1 Flash \u00b7 via deepseek \u2192 OpenCode CLI \u00b7 DeepSeek V4.1 Flash \u00b7 via opencode-go \u00b7 high; the rest of the run uses the new seat',
    },
    {
      type: 'workflow_resumed',
      ts: 1791727007599,
      phase: 'implementing',
    },
    {
      type: 'workflow_config',
      ts: 1791727007600,
      phase: 'implementing',
      plannerTool: 'claude-code',
      plannerModel: 'claude-opus-5-5',
      implementerTool: 'opencode',
      implementerModel: 'opencode-go/deepseek-v4.1-flash',
      reviewerTool: 'codex',
      reviewerModel: 'gpt-6.1-sol',
    },
    {
      type: 'tasks_planned',
      ts: 1791727007806,
      phase: 'implementing',
      tasks: [
        {
          id: 'T001',
          title: 'Add wordCount to src/text.js',
          index: 0,
          file: 'src/text.js',
          action: 'modify',
        },
        {
          id: 'T002',
          title: 'Add optional suffix to truncate in src/preview.js',
          index: 1,
          file: 'src/preview.js',
          action: 'modify',
        },
      ],
      total: 2,
    },
    {
      type: 'task_started',
      ts: 1791727007835,
      phase: 'implementing',
      taskId: 'T001',
      title: 'Add wordCount to src/text.js',
      index: 0,
      total: 2,
      lineageAttempt: 1,
      attemptAllowance: 8,
      file: 'src/text.js',
      files: ['src/text.js', 'test/text.test.js'],
      action: 'modify',
      tool: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      axes: ['high'],
      backendKind: 'cli',
      implementerProfile: 'default',
      contextFit: 'fits',
      estimatedTokens: 1573,
      untruncatedEstimatedTokens: 1573,
      contextLength: 1000000,
      currentCodeTruncated: false,
      currentCodeContextMode: 'none',
      routingReason: 'Selected profile default (fits, estimated 1573/1000000 tokens)',
    },
    {
      type: 'implementer_generate_running',
      ts: 1791727008022,
      phase: 'implementing',
      taskId: 'T001',
      file: 'src/text.js',
      lineageAttempt: 1,
      attemptAllowance: 8,
    },
    {
      type: 'runner_call_started',
      ts: 1791727008291,
      phase: 'implementing',
      taskId: 'T001',
      callId: 'implementer-2',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      axes: ['high'],
      attempt: 0,
      usageBoundary: 'aggregate',
      sequence: 419,
    },
    {
      type: 'steerable_call',
      ts: 1791727013386,
      phase: 'implementing',
      taskId: 'T001',
      seat: 'build',
    },
    {
      type: 'runner_call_session_id',
      ts: 1791727013387,
      phase: 'implementing',
      taskId: 'T001',
      callId: 'implementer-2',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      axes: ['high'],
      attempt: 0,
      usageBoundary: 'aggregate',
      sequence: 420,
      nativeSessionId: 'ses_ed4bf81f5ffeJnkbVh4fsKPGKi',
    },
  ].map((event) => EngineEventSchema.parse(event));

  function project(items = events, cols = 200, expandedDiffs = new Set<string>()) {
    const inputs = {
      sections: groupEventsIntoSections(items),
      cols,
      viewportHeight: 40,
      expandedDiffs,
      expandedActivityBatches: new Set<string>(),
      streaming,
    };
    const projection = buildConversationRowsProjection(inputs);
    const rows = materializeConversationRowsWindow({
      projection,
      windowStart: 0,
      windowEnd: projection.totalRows,
    });
    return { projection, rows, actions: buildConversationRowActions(inputs) };
  }

  it.each([60, 80, 120, 160, 200])(
    'keeps exactly two blocks at %s columns and expands the raw words',
    (cols) => {
      const { projection, rows, actions } = project(events, cols);
      expect(projection.renderableCount).toBe(2);
      const text = rows.map(rowText).join('\n');
      expect(text).toContain('Recovery  Balance spent on OpenCode CLI');
      expect(text.replace(/\s+/gu, ' ')).toContain('continued on fallback');
      expect(text).toContain('ctrl+d');
      expect(text).not.toContain('fallback…');
      expect(text).not.toContain('Add credit');
      expect(text).not.toContain('Change BUILD tool');
      expect(text).not.toContain('BUILD failed');
      expect(text).not.toContain('BUILD activity');
      expect(text).not.toContain('Error');
      expect(text.match(/Balance spent on OpenCode CLI/gu)).toHaveLength(1);
      expect(actions.size).toBeGreaterThan(0);
      const action = actions.values().next().value;
      if (action?.type !== 'toggle-diff') throw new Error('Expected recovery detail toggle');
      expect([...actions.keys()].every((key) => rows.some((row) => row.key === key))).toBe(true);
      const expanded = project(events, cols, new Set([action.key]));
      const detail = expanded.rows.map(rowText).join('\n').replace(/\s+/gu, ' ');
      expect(detail).toContain(words);
      expect(detail).toContain('ctrl+d to collapse');
      expect(detail).not.toContain('Add credit');
      expect(expanded.actions.size).toBeGreaterThan(0);
    },
  );

  it('keeps manual failures and a halt awaiting the person', () => {
    for (const items of [
      events.map((event) => (event.type === 'seat_switched' ? { ...event, auto: false } : event)),
      events.filter(
        (event) => event.type !== 'seat_switched' && event.type !== 'recovery_resolved',
      ),
    ]) {
      const text = project(items).rows.map(rowText).join('\n');
      expect(text).toContain('BUILD activity');
      expect(text).toContain('BUILD failed');
      expect(text).toContain('Add credit');
      expect(text).not.toContain('continued on fallback');
    }
  });

  it('replays the complete spent-b2 switch through the warning and restarted call without a Warning block', () => {
    const { rows } = project([...events, ...resumedEvents]);
    expect(rows.map(rowText).filter((text) => text !== '')).toEqual([
      `Recovery  Balance spent on OpenCode CLI${arrowSep()}continued on fallback  ctrl+d`,
      `BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek${arrowSep()}OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high · automatic fallback`,
      'Run continued',
      'T001 Add wordCount to src/text.js  src/text.js (modify) · +1 file · OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high',
      'working on src/text.js…',
    ]);
  });

  it.each([
    'Unrelated tool warning',
    'PLAN seat changed OpenCode CLI · DeepSeek V4.1 Flash · via deepseek → OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high; context will be rebuilt',
    'BUILD seat changed OpenCode CLI · DeepSeek V4.1 Flash · via deepseek → OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · low; the rest of the run uses the new seat',
    'BUILD seat changed OpenCode CLI · DeepSeek V4.1 Flash · via deepseek → OpenCode CLI · another/model · high; the rest of the run uses the new seat',
  ])('keeps the unrelated warning %s on replay', (message) => {
    const replay = resumedEvents.map((event) =>
      event.type === 'warning' ? { ...event, message } : event,
    );
    const text = project([...events, ...replay])
      .rows.map(rowText)
      .join('\n');
    expect(text).toContain('Warning');
    expect(text).toContain(message);
  });

  it.each(['plan', 'review'] as const)('folds a %s seat failure by the issue and call', (seat) => {
    const items = events
      .filter((event) => event.type !== 'implementer_generate_failed')
      .map((event) => {
        const moved = {
          ...event,
          phase: seat === 'review' ? 'final-review' : 'planning',
          taskId: undefined,
        };
        if ('role' in moved) return { ...moved, role: seat === 'review' ? 'review' : 'planner' };
        if ('seat' in moved) return { ...moved, seat };
        return moved;
      })
      .map((event) => EngineEventSchema.parse(event));
    expect(project(items).projection.renderableCount).toBe(2);
    const { actions } = project(items);
    const action = actions.values().next().value;
    if (action?.type !== 'toggle-diff') throw new Error('Expected recovery detail toggle');
    expect(
      project(items, 200, new Set([action.key]))
        .rows.map(rowText)
        .join('\n'),
    ).toContain(words);
  });

  it('keeps tool activity and failures from another call', () => {
    const tool = makeRunnerCallActivity({
      callId: 'implementer-1',
      taskId: taskId('T001'),
      kind: 'read',
      activityId: 'implementer-1:read',
      label: 'reading src/text.js',
      target: 'src/text.js',
    });
    const other = {
      ...tool,
      callId: 'other-call',
      kind: 'warning' as const,
      activityId: 'other-call:warning',
      label: 'warning unrelated',
      diagnosticPartial: 'Other call warning',
    };
    const { rows } = project([other, tool, ...events]);
    const text = rows.map(rowText).join('\n');
    expect(text).toContain('src/text.js');
    expect(text).toContain('Other call warning');
    expect(text).not.toContain('1 err');
    expect(text).toContain('continued on fallback');
  });

  it('folds a PLAN consult on the same brief by its call id', () => {
    const items = events
      .filter((event) => event.type !== 'implementer_generate_failed')
      .map((event) => {
        if ('role' in event) return { ...event, role: 'escalation' };
        if ('seat' in event) return { ...event, seat: 'plan' };
        return event;
      })
      .map((event) => EngineEventSchema.parse(event));
    expect(project(items).projection.renderableCount).toBe(2);
  });

  it('keeps an unrelated error and a switch whose resolution failed', () => {
    const unrelated = events.map((event) =>
      event.type === 'error' ? { ...event, message: 'Unrelated hook error' } : event,
    );
    expect(project(unrelated).rows.map(rowText).join('\n')).toContain('Unrelated hook error');
    const failed = events.map((event) =>
      event.type === 'recovery_resolved' ? { ...event, outcome: 'aborted' as const } : event,
    );
    const text = project(failed).rows.map(rowText).join('\n');
    expect(text).toContain('BUILD failed');
    expect(text).toContain('Add credit');
    expect(text).not.toContain('continued on fallback');
  });
});
const CLAUDE_CODE_LABEL = 'Claude Code CLI';

function activityLine(label: Parameters<typeof displayActivityLabel>[0], value: string): string {
  return `${displayActivityLabel(label).padEnd(ACTIVITY_LABEL_PAD)}  ${value}`;
}

function activity(
  overrides: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return makeRunnerCallActivity({
    ts: 0,
    phase: 'researching',
    role: 'planner',
    runnerName: 'codex',
    sequence: 1,
    activityId: `${overrides.kind}:${overrides.label}`,
    stage: 'updated',
    kind: 'unknown',
    label: 'checking project',
    ...overrides,
  });
}

beforeEach(forceUnicodeGlyphs);

describe('buildConversationRows', () => {
  it('keeps a task review between its brief and the next brief through the live store', () => {
    resetWorkflow();
    const events: EngineEvent[] = [
      makeTaskStart({ ts: 1_000, title: 'First brief' }),
      makeTaskComplete({ ts: 2_000 }),
      {
        type: 'review_started',
        ts: 3_000,
        phase: 'implementing',
        scope: 'task',
        afterTaskId: 'T001',
        tool: 'codex',
      },
      {
        type: 'review_completed',
        ts: 52_000,
        phase: 'implementing',
        scope: 'task',
        afterTaskId: 'T001',
        tool: 'codex',
        verdict: 'pass',
        findings: { blocking: 0, minor: 0 },
        duration: 49_000,
      },
    ];
    const transcript = () => {
      const { rows } = buildConversationRows({
        sections: groupEventsIntoSections([...eventsStore.get().events]),
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 120,
        viewportHeight: 40,
        streaming,
      });
      const ui = renderFeature(
        createElement(
          Fragment,
          null,
          ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
        ),
        { cols: 120, rows: 40 },
      );
      const lines = stripAnsiStyles(ui.lastFrame()).split('\n');
      ui.unmount();
      return lines;
    };
    try {
      for (const event of events) addEvent(event);
      expect(transcript().filter((line) => line.includes('Review'))).toEqual([
        ' ● Review T001 passed  49.0s',
      ]);
      addEvent(
        makeTaskStart({ ts: 53_000, taskId: taskId('T002'), title: 'Second brief', index: 1 }),
      );
      const lines = transcript();
      const first = lines.findIndex((line) => line.includes('T001 First brief'));
      const review = lines.findIndex((line) => line.includes('● Review T001 passed'));
      const second = lines.findIndex((line) => line.includes('T002 Second brief'));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(review).toBeGreaterThan(first);
      expect(second).toBeGreaterThan(review);
      expect(lines.filter((line) => line.includes('Review T001'))).toHaveLength(1);
    } finally {
      resetWorkflow();
    }
  });

  it('exposes the active task header key from its first row while activity stays live', () => {
    const started = makeTaskStart({
      title: 'Long task title that wraps across several header rows',
    });
    const sections = groupEventsIntoSections([
      makeTaskStart(),
      makeTaskComplete(),
      { ...started, taskId: taskId('T002'), index: 1 },
      activity({ role: 'implementer', phase: 'implementing', taskId: taskId('T002') }),
    ]);
    const projection = buildConversationRowsProjection({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 40,
      viewportHeight: 10,
      streaming,
    });
    const rows = materializeConversationRowsWindow({
      projection,
      windowStart: 0,
      windowEnd: projection.totalRows,
    });
    const header = rows.find((row) => row.kind === 'task-header' && !row.headerContinuation);
    expect(header).toBeDefined();
    expect(projection.activeTaskHeaderKey).toBe(header?.key);
    expect(projection.blocks.at(-1)?.activeRowKey).not.toBe(header?.key);

    const settled = buildConversationRowsProjection({
      sections: groupEventsIntoSections([
        ...sections.flatMap((section) => section.items),
        makeTaskComplete({ taskId: taskId('T002') }),
      ]),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 40,
      viewportHeight: 10,
      streaming,
    });
    expect(settled.activeTaskHeaderKey).toBeNull();
  });

  it('moves the live mark from a batch a stop cut back to its brief once the run continues', () => {
    const buildActivity = (overrides: Partial<EngineEventOf<'runner_call_activity'>>) =>
      activity({
        role: 'implementer',
        phase: 'implementing',
        taskId: taskId('T001'),
        ...overrides,
      });
    const resumed: EngineEvent = { type: 'workflow_resumed', ts: 2_000, phase: 'implementing' };
    const sections = groupEventsIntoSections([
      makeTaskStart(),
      buildActivity({ label: 'tool Read', target: 'src/greet.ts' }),
      buildActivity({
        stage: 'aborted',
        kind: 'error',
        label: 'aborted runner_interrupted',
        diagnosticPartial: 'CLI invocation was aborted',
      }),
      resumed,
    ]);
    const projection = buildConversationRowsProjection({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 100,
      viewportHeight: 20,
      streaming,
    });
    const rows = materializeConversationRowsWindow({
      projection,
      windowStart: 0,
      windowEnd: projection.totalRows,
    });
    const batch = rows.find((row) => row.kind === 'activity');
    expect(batch?.interrupted).toBe(true);
    const { activeRowKey } = computeConversationRowsWindowFromProjection({
      projection,
      viewportHeight: 20,
      rawScrollOffset: 0,
      renderableCountAtScroll: 0,
      heightAtScroll: 0,
    });
    expect(activeRowKey).not.toBe(batch?.key);
    expect(activeRowKey).toBe(projection.activeTaskHeaderKey);
    expect(activeRowKey).not.toBeNull();
  });

  it('takes the live mark off every batch of a call that ended, read through the retained log', () => {
    const call = (callId: string) =>
      ({
        phase: 'implementing',
        taskId: taskId('T001'),
        callId,
        role: 'implementer',
        backendKind: 'cli',
        runnerName: 'codex',
        attempt: 0,
      }) as const;
    const buildActivity = (
      callId: string,
      overrides: Partial<EngineEventOf<'runner_call_activity'>>,
    ) => activity({ ...call(callId), kind: 'read', ...overrides });
    const running: EngineEvent[] = [
      makeTaskStart(),
      makeRunnerCallStarted({ ...call('first'), ts: 0, sequence: 0 }),
      buildActivity('first', { label: 'reading src/greet.ts', target: 'src/greet.ts' }),
      {
        type: 'planner_text',
        ts: 0,
        phase: 'implementing',
        role: 'implementer',
        text: 'Both files are missing, so I will create them.',
      },
      buildActivity('first', { kind: 'edit', label: 'editing src/greet.ts' }),
    ];
    const cut: EngineEvent[] = [
      makeRunnerCallError({
        ...call('first'),
        status: 'aborted',
        error: { code: 'runner_interrupted', message: 'CLI invocation was aborted' },
      }),
      buildActivity('first', {
        activityId: 'first:terminal',
        stage: 'aborted',
        kind: 'error',
        label: 'aborted runner_interrupted',
        diagnosticPartial: 'CLI invocation was aborted',
      }),
    ];
    const marks = (events: EngineEvent[]) => {
      const projection = buildConversationRowsProjection({
        sections: groupEventsIntoSections(mergeEventLog(events)),
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 100,
        viewportHeight: 40,
        streaming,
      });
      const batches = materializeConversationRowsWindow({
        projection,
        windowStart: 0,
        windowEnd: projection.totalRows,
      }).filter((row) => row.kind === 'activity');
      const { activeRowKey } = computeConversationRowsWindowFromProjection({
        projection,
        viewportHeight: 40,
        rawScrollOffset: 0,
        renderableCountAtScroll: 0,
        heightAtScroll: 0,
      });
      expect(projection.activeTaskHeaderKey).not.toBeNull();
      return { batches, activeRowKey, header: projection.activeTaskHeaderKey };
    };

    const live = marks(running);
    expect(live.batches).toHaveLength(2);
    expect(live.activeRowKey).toBe(live.batches[1]?.key);

    const warned = marks([
      ...running,
      buildActivity('first', {
        activityId: 'first:warning:rate-limit',
        stage: 'warning',
        kind: 'error',
        label: 'error claude_rate_limit',
        diagnosticPartial: 'Rate limit reached',
      }),
    ]);
    expect(warned.activeRowKey).toBe(warned.batches.at(-1)?.key);

    const finished = marks([...running, makeRunnerCallCompleted({ ...call('first') })]);
    expect(finished.activeRowKey).toBe(finished.header);

    const cutBeforeStop = marks([...running, ...cut]);
    expect(cutBeforeStop.batches.map((batch) => batch.interrupted)).toEqual([undefined, true]);
    expect(cutBeforeStop.activeRowKey).toBe(cutBeforeStop.header);

    const continued: EngineEvent[] = [
      ...running,
      ...cut,
      {
        type: 'turn_interrupted',
        ts: 1_000,
        phase: 'implementing',
        source: 'user',
        at: 'mid-step',
        step: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
      },
      { type: 'workflow_resumed', ts: 2_000, phase: 'implementing' },
      makeTaskStart(),
      makeRunnerCallStarted({ ...call('continued'), ts: 2_100, sequence: 0 }),
    ];
    const waiting = marks(continued);
    expect(waiting.activeRowKey).toBe(waiting.header);

    const painted = marks([
      ...continued,
      buildActivity('continued', { label: 'reading src/greet.ts', target: 'src/greet.ts' }),
    ]);
    expect(painted.batches).toHaveLength(3);
    expect(painted.activeRowKey).toBe(painted.batches[2]?.key);
  });

  it('retains the target label once above the crew after a started brief is skipped', () => {
    const started = makeTaskStart({
      title: 'Receive stock',
      file: 'src/orders.js',
      files: ['src/orders.js', 'test/orders.test.js'],
      tool: 'claude-code',
      model: 'opus',
      axes: ['max'],
    });
    const sections = groupEventsIntoSections([started, makeTaskSkipped({ title: started.title })]);
    expect(sections[0]).toMatchObject({ summary: { file: started.file } });
    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 120,
      viewportHeight: 40,
      streaming,
    });
    const ui = renderFeature(
      createElement(
        Fragment,
        null,
        ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
      ),
      { cols: 120, rows: 40 },
    );
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    expect(lines[0]).toContain('src/orders.js (modify) · +1 file');
    expect(lines.filter((line) => line.includes('src/orders.js'))).toHaveLength(1);
    expect(lines[1]).toBe('   Claude Code CLI · Opus 5.5 · max');
    expect(rows.filter((row) => row.kind === 'task-header')).toHaveLength(0);
    ui.unmount();
  });

  it('keeps the renderable count unchanged when a brief settles without a generate hint', () => {
    const started = makeTaskStart({ tool: 'claude-code', model: 'opus', axes: ['max'] });
    const narration: EngineEvent = {
      type: 'planner_text',
      ts: 1,
      phase: 'implementing',
      text: 'Kept body.',
    };
    const input = {
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 120,
      viewportHeight: 40,
      streaming,
    };
    const live = buildConversationRowsProjection({
      ...input,
      sections: groupEventsIntoSections([started, narration]),
    });
    const settled = buildConversationRowsProjection({
      ...input,
      sections: groupEventsIntoSections([started, narration, makeTaskComplete()]),
    });
    expect(settled.renderableCount).toBe(live.renderableCount);
  });

  it.each(['', 'src/current.ts'])(
    'uses the recorded file when the settled target is empty (%s)',
    (file) => {
      const started = makeTaskStart({ title: 'Update report', file });
      const { rows } = buildConversationRows({
        sections: [
          {
            type: 'completed-task',
            startIndex: 0,
            summary: {
              id: started.taskId,
              title: started.title,
              file: 'src/recorded.ts',
              method: 'local',
              retries: 0,
              duration: 1000,
            },
            items: [started],
          },
        ],
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 120,
        viewportHeight: 40,
        streaming,
      });
      const ui = renderFeature(
        createElement(
          Fragment,
          null,
          ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
        ),
      );
      const heading = stripAnsiStyles(ui.lastFrame()).split('\n')[0];
      expect(heading).toContain(file === '' ? 'src/recorded.ts' : 'src/current.ts (modify)');
      ui.unmount();
    },
  );

  it.each(['done', 'failed', 'skipped'] as const)(
    'places the file on the %s heading and crew directly below it before the body',
    (status) => {
      const method = status === 'done' ? makeTaskComplete().method : status;
      const started = makeTaskStart({
        title: 'Receive stock',
        file: 'src/orders.js',
        tool: 'claude-code',
        model: 'opus',
        axes: ['high', 'thinking'],
      });
      const { rows } = buildConversationRows({
        sections: [
          {
            type: 'completed-task',
            startIndex: 0,
            summary: {
              id: started.taskId,
              title: started.title,
              file: started.file,
              method,
              retries: 0,
              duration: 120_000,
            },
            items: [
              started,
              {
                type: 'planner_text',
                ts: 1,
                phase: 'implementing',
                role: 'implementer',
                text: 'Receiving body.',
              },
            ],
          },
        ],
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 120,
        viewportHeight: 40,
        streaming,
      });
      const liveRows = buildConversationRows({
        sections: [{ type: 'events', startIndex: 0, items: [started] }],
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 60,
        viewportHeight: 40,
        streaming,
      }).rows;
      const crew = 'Claude Code CLI · Opus 5.5 · high · thinking';
      expect(liveRows.map(rowText).join('\n')).toContain(crew);
      expect(rows[0]?.node).toBeDefined();
      expect(rows.map(rowText)[1]).toBe(crew);
      expect(rows[2]?.kind).toBe('spacer');
      const ui = renderFeature(
        createElement(
          Fragment,
          null,
          ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
        ),
      );
      const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
      expect(lines[0]).toContain('src/orders.js (modify)');
      expect(lines.filter((line) => line.includes('src/orders.js'))).toHaveLength(1);
      expect(lines[1]).toBe(`   ${crew}`);
      expect(lines[3]).toContain('Receiving body.');
      ui.unmount();
    },
  );

  it.each(
    (['planner', 'implementer', 'review'] as const).flatMap((role) => [
      { role, kind: 'read' as const, markerTone: runnerActivityModelRole(role) },
      { role, kind: 'warning' as const, markerTone: 'warning' },
      { role, kind: 'error' as const, markerTone: 'error' },
    ]),
  )(
    'preserves every segment tone of a settled $role $kind header and keeps its marker tone',
    ({ role, kind, markerTone }) => {
      const event = activity({
        role,
        kind,
        label: 'reading src/orders.js',
        model: 'gpt-5',
      });
      const sections: Section<EngineEvent>[] =
        role === 'implementer'
          ? [
              {
                type: 'completed-task',
                startIndex: 0,
                items: [event],
                summary: {
                  id: taskId('T001'),
                  title: 'Receive stock',
                  method: 'local',
                  retries: 0,
                  duration: 100,
                },
              },
            ]
          : [
              {
                type: 'settled-stage',
                startIndex: 0,
                items: [event],
                summary:
                  role === 'planner'
                    ? { stage: 'plan', feature: 'Receive stock', duration: 100 }
                    : {
                        stage: 'review',
                        scope: 'final',
                        fixCyclesBefore: 0,
                        rerunsBefore: 0,
                        outcome: 'passed',
                        failedCommands: [],
                        failedChecks: 0,
                        fixes: [],
                        duration: 100,
                      },
              },
            ];
      const input = {
        expandedDiffs: new Set<string>(),
        expandedActivityBatches: new Set<string>(),
        cols: 120,
        viewportHeight: 40,
        streaming,
      };
      const live = buildConversationRows({
        ...input,
        sections: [{ type: 'events', startIndex: 0, items: [event] }],
      });
      const settled = buildConversationRows({ ...input, sections });
      expect(live.rows.find((row) => row.kind === 'activity')?.segments[0]?.tone).not.toBe(
        'textDim',
      );
      const liveHeader = live.rows.find((row) => row.kind === 'activity');
      const settledHeader = settled.rows.find((row) => row.kind === 'activity');
      expect(settledHeader).toBeDefined();
      expect(settledHeader?.segments).toEqual(liveHeader?.segments);
      expect(settledHeader?.segments[0]?.tone).toBe(runnerActivityModelRole(role));
      expect(
        settledHeader?.segments.find((segment) => segment.text === `${CODEX_LABEL} · GPT-5`),
      ).toMatchObject({ tone: runnerActivityModelRole(role) });
      if (kind !== 'read') {
        expect(
          settledHeader?.segments.find(
            (segment) => segment.text === `1 ${kind === 'warning' ? 'warn' : 'err'}`,
          ),
        ).toMatchObject({ tone: markerTone });
      }
      expect(settledHeader?.segments.map((segment) => segment.text).join('')).toContain(
        `[${CODEX_LABEL} · GPT-5]`,
      );
      expect(settledHeader?.markerTone).toBe(liveHeader?.markerTone);
      expect(settledHeader?.markerTone).toBe(markerTone);
    },
  );

  it.each(['passed', 'failed'] as const)(
    'materializes one terminal %s Review row with its own duration',
    (review) => {
      const events: EngineEvent[] = [
        makeTaskStart(),
        makeTaskComplete(),
        { type: 'planner_text', ts: 3_000, phase: 'final-review', text: 'Checking the diff.' },
        { type: 'workflow_complete', ts: 8_000, phase: 'complete', review },
      ];
      const { rows } = buildConversationRows({
        sections: groupEventsIntoSections(events),
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 60,
        viewportHeight: 18,
        streaming,
      });
      expect(rows.filter((row) => row.node !== undefined)).toHaveLength(2);
      const ui = renderFeature(
        createElement(
          Fragment,
          null,
          ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
        ),
      );
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain(`Final review ${review}`);
      expect(frame).toContain('5.0s');
      expect(frame).toContain('Checking the diff.');
      ui.unmount();
    },
  );
  it('settles without losing readable body rows', () => {
    const suite = (
      id: string,
      phase: EngineEventOf<'full_suite'>['phase'],
      moment: EngineEventOf<'full_suite'>['moment'],
    ): EngineEventOf<'full_suite'> => ({
      type: 'full_suite',
      ts: 2,
      phase,
      status: 'done',
      stage: 'test',
      id,
      command: `check-${id}`,
      moment,
      passed: true,
      duration: 100,
    });
    const events: EngineEvent[] = [
      { type: 'workflow_started', ts: 0, phase: 'planning', feature: 'Keep the log' },
      { type: 'user_message', ts: 1, phase: 'planning', text: 'Keep the log' },
      suite('P0', 'planning', 'plan'),
      makeTaskStart({ title: 'First brief', file: 'src/first.ts', tool: 'codex' }),
      makeImplementerGenerate({ status: 'running', file: 'src/first.ts' }),
      {
        type: 'planner_text',
        ts: 3,
        phase: 'implementing',
        role: 'implementer',
        text: 'First narration.',
      },
      ...['a', 'b', 'c', 'd'].map((name, index) =>
        activity({
          phase: 'implementing',
          role: 'implementer',
          sequence: index + 1,
          activityId: name,
          kind: 'read',
          label: `reading ${name}.ts`,
        }),
      ),
      {
        type: 'validate',
        ts: 4,
        phase: 'validating-task',
        taskId: taskId('T001'),
        status: 'done',
        stages: { typecheck: true, lint: true, test: true },
        passed: true,
      },
      {
        type: 'planner_text',
        ts: 5,
        phase: 'implementing',
        role: 'implementer',
        content: 'markdown',
        text: 'Handed back.\n{"status":"done","filesChanged":["src/first.ts"],"touchedNotSuggested":[],"notes":null,"decisions":[]}',
      },
      makeTaskComplete(),
      {
        type: 'task_skipped',
        ts: 6,
        phase: 'implementing',
        taskId: taskId('T002'),
        title: 'Pre-hook skip',
        reason: 'Denied by hook',
      },
      makeTaskStart({ taskId: taskId('T003'), title: 'Failed brief', file: 'src/failed.ts' }),
      { type: 'error', ts: 7, phase: 'implementing', message: 'Failure evidence retained' },
      { type: 'task_full_fail', ts: 8, phase: 'implementing', taskId: taskId('T003') },
      suite('V1', 'final-review', 'pre-review'),
      suite('P1', 'final-review', 'plan'),
      { type: 'workflow_complete', ts: 9, phase: 'complete', review: 'failed' },
      { type: 'user_message', ts: 10, phase: 'final-review', text: 'Please check again' },
      suite('V2', 'final-review', 'pre-review'),
      suite('P2', 'final-review', 'plan'),
      { type: 'workflow_complete', ts: 11, phase: 'complete', review: 'passed' },
      {
        type: 'recovery_resolved',
        ts: 12,
        phase: 'complete',
        issueId: 'tail',
        reason: 'checkout-changed',
        action: 'retry-same-worker',
        outcome: 'continued',
      },
    ];
    const inputs = {
      sections: groupEventsIntoSections(events),
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 120,
      viewportHeight: 20,
      streaming: { active: true, taskId: taskId('T001'), lines: ['stale preview'] },
    };
    const projection = buildConversationRowsProjection(inputs);
    const rows = materializeConversationRowsWindow({
      projection,
      windowStart: 0,
      windowEnd: projection.totalRows,
    });
    const ui = renderFeature(
      createElement(
        Fragment,
        null,
        ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
      ),
    );
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const lineOf = (text: string) => {
      const index = lines.findIndex((line) => line.includes(text));
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    const ordered = [
      'Plan Keep the log',
      'Plan check P0',
      'T001 First brief',
      'src/first.ts',
      'First narration.',
      'activity',
      'Validate',
      'Handed back.',
      'Report',
      'T002 Pre-hook skip',
      'T003 Failed brief',
      'Failure evidence retained',
      'Reviewer check V1',
      'Plan check P1',
      'Final review failed',
      'Please check again',
      'Reviewer check V2',
      'Plan check P2',
      'Final review re-run passed',
      'Recovery',
    ];
    const indices = ordered.map(lineOf);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(lines.join('\n')).not.toContain('working on');
    expect(lines.join('\n')).not.toContain('stale preview');
    expect(lines.join('\n')).not.toContain('Task failed');
    expect(rows.filter((row) => row.node !== undefined)).toHaveLength(6);
    expect(rows.filter((row) => row.kind === 'task-header')).toHaveLength(0);
    expect(projection.blocks.every((block) => block.activeRowKey === undefined)).toBe(true);
    for (const [index, row] of rows.entries()) {
      if (row.node !== undefined && index > 0) {
        expect(rows[index - 1]?.kind).toBe('spacer');
        expect(rows[index - 2]?.kind).not.toBe('spacer');
      }
    }
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(new Set(projection.blocks.map((block) => block.key)).size).toBe(
      projection.blocks.length,
    );
    expect(projection.totalRows).toBe(rows.length);
    expect(
      materializeConversationRowsWindow({
        projection,
        windowStart: projection.totalRows - 2,
        windowEnd: projection.totalRows,
      }),
    ).toEqual(rows.slice(-2));
    ui.unmount();
  });
  it('strips the planner H1 that echoes the user prompt so the title renders once', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          { type: 'user_message', ts: 0, phase: 'idle', text: 'Add dark-mode toggle' },
          {
            type: 'planner_text',
            ts: 1,
            phase: 'analyzing',
            content: 'markdown',
            text: '# Add dark-mode toggle\n\nLooking into the request now.',
          },
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');
    const occurrences = text.split('Add dark-mode toggle').length - 1;

    expect(occurrences).toBe(1);
    expect(text).toContain('Looking into the request now.');
  });

  it('batches repeated runner activity from one call into one renderable block', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'call-1:tool:sed',
            kind: 'command',
            label: 'running /bin/zsh -lc "sed -n \'1,240p\' CLAUDE.md"',
            target: '/bin/zsh -lc "sed -n \'1,240p\' CLAUDE.md"',
          }),
          activity({
            sequence: 2,
            activityId: 'call-1:tool:sed',
            kind: 'command',
            label: '/bin/zsh -lc "sed -n \'1,240p\' CLAUDE.md"',
          }),
          activity({
            sequence: 3,
            activityId: 'call-1:tool:wc',
            kind: 'command',
            label: 'running wc -l CLAUDE.md',
            target: 'wc -l CLAUDE.md',
          }),
          activity({
            sequence: 4,
            activityId: 'call-1:plan:rg',
            kind: 'plan',
            label: 'planning /bin/zsh -lc "rg -n \\"Task Brief|brief|tasks\\\\.md\\""',
          }),
        ],
      },
    ];

    const { rows, renderableCount } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(renderableCount).toBe(3);
    expect(text).toContain(`${CREW_SEAT_LABELS.plan} activity  3 updates  [${CODEX_LABEL} · auto]`);
    expect(text).not.toContain('sed -n');
    expect(text).toContain(activityLine('READ', 'CLAUDE.md :1-240'));
    expect(text).toContain(activityLine('RUN', 'wc -l CLAUDE.md'));
    expect(text).toContain(activityLine('PLAN', 'rg -n "Task Brief|brief|tasks\\.md"'));
    expect(text).not.toContain('/bin/zsh -lc');
    expect(text).not.toContain('activity:');
  });

  it('counts tool updates by their activity identity', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'run-level',
            kind: 'command',
            label: 'running /bin/zsh -lc "npm run typecheck"',
            target: '/bin/zsh -lc "npm run typecheck"',
          }),
          activity({
            sequence: 2,
            activityId: 'run-level',
            kind: 'command',
            label: '/bin/zsh -lc "npm run typecheck"',
          }),
          activity({
            sequence: 3,
            activityId: 'run-level',
            kind: 'command',
            label: 'running npm run typecheck',
            target: 'npm run typecheck',
          }),
          activity({
            sequence: 4,
            activityId: 'read',
            kind: 'read',
            label: 'reading src/app.ts',
          }),
        ],
      },
    ];

    const { rows, renderableCount } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(renderableCount).toBe(2);
    expect(text).toContain(`${CREW_SEAT_LABELS.plan} activity  2 updates  [${CODEX_LABEL} · auto]`);
    expect(text.match(/npm run typecheck/g)).toHaveLength(1);
    expect(text).toContain(activityLine('READ', 'src/app.ts'));
    expect(text).not.toContain('+  ');
  });

  it('keeps recent activity rows with a +N more affordance', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
          activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
          activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
          activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
        ],
      },
    ];

    const { rows, renderableCount } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(renderableCount).toBe(4);
    expect(text).toContain(`${CREW_SEAT_LABELS.plan} activity  4 updates  [${CODEX_LABEL} · auto]`);
    expect(text).not.toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('c.ts');
    expect(text).toContain('d.ts');
    expect(text).toContain('+1 more · ctrl+a');
    expect(text).not.toContain('/activity');
    expect(text).not.toContain('Ctrl+A');
    expect(text).not.toContain('┌─');
    expect(text).not.toContain('└');

    const expanded = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set([activityBatchKey(0, 'call-1')]),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const expandedText = expanded.rows.map(rowText).join('\n');

    expect(expandedText).toContain('collapse');
    expect(expandedText).toContain('a.ts');
  });

  it('keeps a collapsed activity block in event order, the warning counted in its header', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'warning',
            kind: 'warning',
            label: 'warning stderr',
          }),
          activity({ sequence: 2, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
          activity({ sequence: 3, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
          activity({ sequence: 4, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
          activity({ sequence: 5, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain(
      `${CREW_SEAT_LABELS.plan} activity  5 updates  1 warn  [${CODEX_LABEL} · auto]`,
    );
    const warnLine = activityLine('WARN', 'stderr');
    expect(text).not.toContain(warnLine);
    expect(text).not.toContain(activityLine('READ', 'a.ts'));
    expect(text).toContain(activityLine('READ', 'b.ts'));
    expect(text.indexOf(activityLine('READ', 'b.ts'))).toBeLessThan(
      text.indexOf(activityLine('READ', 'c.ts')),
    );
    expect(text.indexOf(activityLine('READ', 'c.ts'))).toBeLessThan(
      text.indexOf(activityLine('READ', 'd.ts')),
    );

    const expanded = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set([activityBatchKey(0, 'call-1')]),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const expandedText = expanded.rows.map(rowText).join('\n');

    expect(expandedText).toContain('collapse');
    expect(expandedText).toContain(activityLine('READ', 'a.ts'));
    expect(expandedText).toContain(activityLine('READ', 'b.ts'));
    expect(expandedText.indexOf(warnLine)).toBeLessThan(
      expandedText.indexOf(activityLine('READ', 'a.ts')),
    );
    expect(expandedText.indexOf(activityLine('READ', 'a.ts'))).toBeLessThan(
      expandedText.indexOf(activityLine('READ', 'b.ts')),
    );
    expect(expandedText.indexOf(activityLine('READ', 'b.ts'))).toBeLessThan(
      expandedText.indexOf(activityLine('READ', 'c.ts')),
    );
    expect(expandedText.indexOf(activityLine('READ', 'c.ts'))).toBeLessThan(
      expandedText.indexOf(activityLine('READ', 'd.ts')),
    );
  });

  it('sanitizes runner metadata in compact activity batch headers', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'a',
            kind: 'read',
            label: 'reading a.ts',
            runnerName: `runner ${jwt}`,
            model: 'model sk-abcdefghijklmnopqrstuvwxyz',
          }),
          activity({
            sequence: 2,
            activityId: 'b',
            kind: 'read',
            label: 'reading b.ts',
            runnerName: `runner ${jwt}`,
            model: 'model sk-abcdefghijklmnopqrstuvwxyz',
          }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 120,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('runner ***REDACTED***');
    expect(text).toContain('Model sk ***REDACTED***');
    expect(text).not.toContain('eyJhbGci');
    expect(text.toLowerCase()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('renders an interrupted call with the stop mark and no internal runner codes', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            stage: 'aborted',
            kind: 'error',
            label: 'aborted runner_interrupted',
            diagnosticPartial: 'Claude stream interrupted',
          }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain(activityLine('STOP', 'current turn interrupted'));
    expect(text).not.toContain('runner_interrupted');
    const header = rows.find((row) => row.kind === 'activity');
    expect(header?.interrupted).toBe(true);
    expect(header === undefined ? '' : rowText(header)).toContain('1 update  interrupted');
    expect(text).not.toContain('warn');
  });

  it('shows sanitized warning and error diagnostics in the compact transcript', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'warning',
            stage: 'warning',
            kind: 'warning',
            label: 'warning stderr',
            diagnosticPartial: 'npm deprecated package token sk-abcdefghijklmnopqrstuvwxyz',
            redacted: true,
          }),
          activity({
            sequence: 2,
            activityId: 'error',
            stage: 'failed',
            kind: 'error',
            label: 'failed exit_code_1',
            diagnosticPartial: 'Command failed: npm test',
          }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 96,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain(
      activityLine('WARN', 'stderr: npm deprecated package token sk-***REDACTED***'),
    );
    expect(text).toContain(activityLine('ERR', 'exit_code_1: Command failed: npm test'));
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('row-less events never split an activity batch', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
          makePlannerHeartbeat({ ts: 1 }),
          activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
          makePlannerStatus({ ts: 2, phase: 'researching' }),
          activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
          makeTaskTokens({ ts: 3 }),
          activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
        ],
      },
    ];

    const { rows, renderableCount } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(renderableCount).toBe(4);
    expect(text.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(1);
    expect(text).toContain(`${CREW_SEAT_LABELS.plan} activity  4 updates  [${CODEX_LABEL} · auto]`);
    expect(text).not.toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('c.ts');
    expect(text).toContain('d.ts');
  });

  it('a visible foreign row closes the activity batch', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' }),
          activity({ sequence: 2, activityId: 'b', kind: 'read', label: 'reading b.ts' }),
          activity({ sequence: 3, activityId: 'c', kind: 'read', label: 'reading c.ts' }),
          activity({ sequence: 4, activityId: 'd', kind: 'read', label: 'reading d.ts' }),
          { type: 'planner_text', ts: 5, phase: 'researching', text: 'Status update.' },
          activity({ sequence: 5, activityId: 'e', kind: 'read', label: 'reading e.ts' }),
          activity({ sequence: 6, activityId: 'f', kind: 'read', label: 'reading f.ts' }),
          activity({ sequence: 7, activityId: 'g', kind: 'read', label: 'reading g.ts' }),
          activity({ sequence: 8, activityId: 'h', kind: 'read', label: 'reading h.ts' }),
        ],
      },
    ];

    const { rows } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(2);
    expect(text).toContain('Status update.');
    expect(text).not.toContain('a.ts');
    expect(text).toContain('d.ts');
    expect(text).not.toContain('e.ts');
    expect(text).toContain('h.ts');
  });

  it('a long runner call with interleaved heartbeats yields one coalescing ledger', () => {
    const longCall: EngineEvent[] = [
      activity({ sequence: 1, activityId: 'read-app', kind: 'read', label: 'reading src/app.ts' }),
      makePlannerHeartbeat({ ts: 1 }),
      activity({
        sequence: 2,
        activityId: 'typecheck',
        kind: 'command',
        label: 'running npm run typecheck',
        target: 'npm run typecheck',
      }),
      makePlannerStatus({ ts: 2, phase: 'researching' }),
      activity({
        sequence: 3,
        activityId: 'read-config',
        kind: 'read',
        label: 'reading src/config.ts',
      }),
      makePlannerHeartbeat({ ts: 3 }),
      makeTaskTokens({ ts: 4 }),
      activity({
        sequence: 4,
        activityId: 'search-store',
        kind: 'search',
        label: 'searching createStore',
      }),
      makePlannerHeartbeat({ ts: 5 }),
      activity({
        sequence: 5,
        activityId: 'read-store',
        kind: 'read',
        label: 'reading src/stores/create-store.ts',
      }),
      makePlannerStatus({ ts: 6, phase: 'researching' }),
      activity({
        sequence: 6,
        activityId: 'plan-briefs',
        kind: 'plan',
        label: 'planning task briefs',
      }),
      makePlannerHeartbeat({ ts: 7 }),
      makeTaskTokens({ ts: 8 }),
      activity({
        sequence: 7,
        activityId: 'read-docs',
        kind: 'read',
        label: 'reading docs/STORES.md',
      }),
      makePlannerHeartbeat({ ts: 9 }),
      activity({
        sequence: 8,
        activityId: 'run-tests',
        kind: 'command',
        label: 'running npm test',
        target: 'npm test',
      }),
    ];

    const single = buildConversationRows({
      sections: [{ type: 'events', startIndex: 0, items: longCall }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const singleText = single.rows.map(rowText).join('\n');

    expect(singleText.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(1);
    expect(singleText).toContain(
      `${CREW_SEAT_LABELS.plan} activity  8 updates  [${CODEX_LABEL} · auto]`,
    );
    expect(single.renderableCount).toBe(8);

    const continued: EngineEvent[] = [
      ...longCall,
      { type: 'planner_text', ts: 10, phase: 'researching', text: 'Draft plan ready.' },
      activity({
        sequence: 9,
        activityId: 'read-router',
        kind: 'read',
        label: 'reading src/router.ts',
      }),
      activity({
        callId: 'call-2',
        sequence: 1,
        activityId: 'read-verify',
        kind: 'read',
        label: 'reading src/verify.ts',
      }),
    ];

    const resumed = buildConversationRows({
      sections: [{ type: 'events', startIndex: 0, items: continued }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const resumedText = resumed.rows.map(rowText).join('\n');

    expect(resumedText).toContain('Draft plan ready.');
    expect(resumedText.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(3);
  });

  it('planner and implementer calls coalesce identically', () => {
    const read = (
      role: 'planner' | 'implementer',
      runnerName: string,
      sequence: number,
      file: string,
    ) =>
      activity({
        role,
        runnerName,
        sequence,
        activityId: file,
        kind: 'read',
        label: `reading ${file}`,
      });
    const callEvents = (role: 'planner' | 'implementer', runnerName: string): EngineEvent[] => [
      read(role, runnerName, 1, 'a.ts'),
      makePlannerHeartbeat({ ts: 1 }),
      read(role, runnerName, 2, 'b.ts'),
      makePlannerStatus({ ts: 2, phase: 'researching' }),
      read(role, runnerName, 3, 'c.ts'),
      makeTaskTokens({ ts: 3 }),
      read(role, runnerName, 4, 'd.ts'),
      makePlannerHeartbeat({ ts: 4 }),
      read(role, runnerName, 5, 'e.ts'),
      read(role, runnerName, 6, 'f.ts'),
    ];
    const buildFor = (items: EngineEvent[]) =>
      buildConversationRows({
        sections: [{ type: 'events', startIndex: 0, items }],
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 88,
        viewportHeight: 20,
        streaming,
      });

    const planner = buildFor(callEvents('planner', 'codex'));
    const implementer = buildFor(callEvents('implementer', 'claude-code'));
    const plannerText = planner.rows.map(rowText).join('\n');
    const implementerText = implementer.rows.map(rowText).join('\n');

    expect(plannerText.match(new RegExp(`${CREW_SEAT_LABELS.plan} activity`, 'g'))).toHaveLength(1);
    expect(
      implementerText.match(new RegExp(`${CREW_SEAT_LABELS.build} activity`, 'g')),
    ).toHaveLength(1);
    expect(plannerText).toContain(
      `${CREW_SEAT_LABELS.plan} activity  6 updates  [${CODEX_LABEL} · auto]`,
    );
    expect(implementerText).toContain(
      `${CREW_SEAT_LABELS.build} activity  6 updates  [${CLAUDE_CODE_LABEL} · auto]`,
    );
    expect(plannerText).toContain('+3 more');
    expect(implementerText).toContain('+3 more');
    expect(implementer.renderableCount).toBe(planner.renderableCount);
    expect(implementer.rows).toHaveLength(planner.rows.length);
  });

  it('names each batch after the tool and model its own call ran, as the seat identity spells them', () => {
    // The Claude runner names a plan call by its command and a build call by its tool id, both on
    // the `opus` alias. The Codex call is the plan seat after a swap; the Claude batches keep theirs.
    const call = (input: {
      callId: string;
      role: 'planner' | 'implementer';
      runnerName: string;
      model: string;
      sequence: number;
    }) =>
      activity({
        callId: input.callId,
        role: input.role,
        runnerName: input.runnerName,
        model: input.model,
        sequence: input.sequence,
        activityId: input.callId,
        kind: 'read',
        label: `reading ${input.callId}.ts`,
      });
    const { rows } = buildConversationRows({
      sections: [
        {
          type: 'events',
          startIndex: 0,
          items: [
            call({
              callId: 'plan-claude',
              role: 'planner',
              runnerName: 'claude',
              model: 'opus',
              sequence: 1,
            }),
            call({
              callId: 'build-claude',
              role: 'implementer',
              runnerName: 'claude-code',
              model: 'opus',
              sequence: 2,
            }),
            call({
              callId: 'plan-codex',
              role: 'planner',
              runnerName: 'codex',
              model: 'gpt-5.5',
              sequence: 3,
            }),
          ],
        },
      ],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });

    expect(rows.filter((row) => row.kind === 'activity').map(rowText)).toEqual([
      `${CREW_SEAT_LABELS.plan} activity  1 update  [${CLAUDE_CODE_LABEL} · Opus 5.5]`,
      `${CREW_SEAT_LABELS.build} activity  1 update  [${CLAUDE_CODE_LABEL} · Opus 5.5]`,
      `${CREW_SEAT_LABELS.plan} activity  1 update  [${CODEX_LABEL} · GPT-5.5]`,
    ]);
  });

  it('sheds the model, then the whole runner, before a narrow header would cut a name', () => {
    const items = [
      activity({ runnerName: 'claude', model: 'opus', kind: 'read', label: 'reading a.ts' }),
      activity({
        runnerName: 'claude',
        model: 'opus',
        sequence: 2,
        activityId: 'warning',
        stage: 'warning',
        kind: 'warning',
        label: 'warning stderr',
      }),
    ];
    const headerAt = (cols: number): string | undefined => {
      const [header] = buildConversationRows({
        sections: [{ type: 'events', startIndex: 0, items }],
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols,
        viewportHeight: 20,
        streaming,
      }).rows;
      return header === undefined ? undefined : rowText(header);
    };
    const summary = `${CREW_SEAT_LABELS.plan} activity  2 updates  1 warn`;

    expect(headerAt(88)).toBe(`${summary}  [${CLAUDE_CODE_LABEL} · Opus 5.5]`);
    expect(headerAt(60)).toBe(`${summary}  [${CLAUDE_CODE_LABEL}]`);
    expect(headerAt(48)).toBe(summary);
  });

  it('expands two same-timestamp diffs independently', () => {
    const ts = 1234;
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          makeImplementerGenerate({ status: 'done', file: 'a.ts', diff: '+ first line', ts }),
          makeImplementerGenerate({ status: 'done', file: 'b.ts', diff: '+ second line', ts }),
        ],
      },
    ];
    const inputs = {
      sections,
      expandedActivityBatches: new Set<string>(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    };

    const firstExpanded = buildConversationRows({
      ...inputs,
      expandedDiffs: new Set(['implementer_generate_done:0']),
    });
    const firstText = firstExpanded.rows.map(rowText).join('\n');
    expect(firstText).toContain('first line');
    expect(firstText).not.toContain('second line');

    const secondExpanded = buildConversationRows({
      ...inputs,
      expandedDiffs: new Set(['implementer_generate_done:1']),
    });
    const secondText = secondExpanded.rows.map(rowText).join('\n');
    expect(secondText).toContain('second line');
    expect(secondText).not.toContain('first line');
  });

  it('ten done briefs all appear as rows in the transcript projection', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => {
      const id = taskId(`T${String(i + 1).padStart(3, '0')}`);
      return [
        makeTaskStart({ taskId: id, title: `Brief ${id}`, index: i, total: 10 }),
        makeTaskComplete({ taskId: id, method: 'local', retries: 0, duration: 1000 }),
      ];
    }).flat();
    const sections = groupEventsIntoSections(tasks);
    const { rows, renderableCount } = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 100,
      viewportHeight: 30,
      streaming,
    });
    expect(rows.filter((row) => row.node !== undefined)).toHaveLength(10);
    expect(renderableCount).toBe(10);
    const ui = renderFeature(
      createElement(
        Fragment,
        null,
        ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
      ),
    );
    const lines = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .filter((line) => /T\d{3} Brief/.test(line));
    for (let index = 0; index < 10; index++) {
      const id = `T${String(index + 1).padStart(3, '0')}`;
      expect(lines[index]).toContain(`${id} Brief ${id}`);
    }
    ui.unmount();
  });

  it('gives a settled brief one file list and one duration', () => {
    const report = JSON.stringify({
      status: 'done',
      filesChanged: ['tests/clamp.test.js'],
      touchedNotSuggested: [],
      notes: null,
      decisions: [],
    });
    const events: EngineEvent[] = [
      makeTaskStart({ taskId: taskId('T001'), title: 'Add clamp helper', file: 'src/clamp.js' }),
      { type: 'planner_text', ts: 1, phase: 'implementing', role: 'implementer', text: report },
      makeImplementerGenerate({
        file: 'src/clamp.js',
        files: [],
        duration: 9170,
        noChange: true,
        kept: ['src/clamp.js', 'tests/clamp.test.js'],
      }),
      makeTaskComplete({ taskId: taskId('T001'), duration: 9842 }),
    ];
    const { rows } = buildConversationRows({
      sections: groupEventsIntoSections(events),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 120,
      viewportHeight: 30,
      streaming,
    });
    const ui = renderFeature(
      createElement(
        Fragment,
        null,
        ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
      ),
    );
    const text = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    expect(text).toContain('src/clamp.js · tests/clamp.test.js');
    expect(text).toContain('Report  done · 0 decisions');
    expect(text).not.toContain('1 file');
    expect(text.match(/\d+\.\ds/g)).toEqual(['9.8s']);
  });
});

describe('rows no brief owns stay with the completed briefs', () => {
  const runLevelWarning: EngineEventOf<'warning'> = {
    type: 'warning',
    ts: 2,
    phase: 'implementing',
    message: 'Ignoring changed files that could not be read: src/tmp.lock.',
  };
  const runLevelSuite: EngineEventOf<'full_suite'> = {
    type: 'full_suite',
    ts: 2,
    phase: 'implementing',
    status: 'done',
    stage: 'typecheck',
    command: 'npm run typecheck',
    moment: 'base',
    passed: true,
    duration: 16003,
  };
  const touched: EngineEventOf<'task_touched_not_suggested'> = {
    type: 'task_touched_not_suggested',
    ts: 3,
    phase: 'implementing',
    taskId: taskId('T001'),
    files: ['skills/splitbrief-run/references/tool-recipes.md'],
  };

  it('keeps them readable once the next brief runs', () => {
    const events: EngineEvent[] = [
      {
        type: 'tasks_planned',
        ts: 1,
        phase: 'implementing',
        tasks: [],
        total: 2,
      },
      runLevelSuite,
      runLevelWarning,
      makeTaskStart({ taskId: taskId('T001'), title: 'First brief', index: 0 }),
      makeTaskComplete({ taskId: taskId('T001') }),
      touched,
      makeTaskStart({ taskId: taskId('T002'), title: 'Second brief', index: 1 }),
    ];

    const { rows } = buildConversationRows({
      sections: groupEventsIntoSections(events),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 120,
      viewportHeight: 30,
      streaming,
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('Second brief');
    expect(text).not.toContain('timed out');
    expect(text).toContain('tool-recipes.md');
    expect(text).toContain('npm run typecheck');
    expect(text).toContain(runLevelWarning.message);
  });
});

describe('the Final review heading', () => {
  const planCheck: EngineEventOf<'full_suite'> = {
    type: 'full_suite',
    ts: 3_000,
    phase: 'final-review',
    status: 'running',
    id: 'K1',
    command: 'node --test tests/math.test.js',
    moment: 'plan',
  };
  const review = { phase: 'final-review', scope: 'final', tool: 'claude-code' } as const;
  const events: EngineEvent[] = [
    makeTaskStart({ ts: 1_000 }),
    makeTaskComplete({ ts: 2_000 }),
    makeTaskTokens({ ts: 2_100 }),
    planCheck,
    { ...planCheck, ts: 3_100, status: 'done', passed: true, duration: 100 },
    {
      type: 'checks_run',
      ts: 3_200,
      phase: 'final-review',
      taskId: taskId('T001'),
      results: [{ id: 'K1', status: 'pass' }],
    },
    { type: 'review_started', ts: 3_300, ...review },
    {
      type: 'review_checks',
      ts: 9_000,
      ...review,
      status: 'planned',
      commands: [{ id: 'V1', command: 'node --test', reason: 'Run the whole suite.' }],
    },
    {
      type: 'full_suite',
      ts: 9_100,
      phase: 'final-review',
      status: 'done',
      id: 'V1',
      command: 'node --test',
      moment: 'pre-review',
      passed: true,
      duration: 200,
    },
    { type: 'review_completed', ts: 18_000, ...review, verdict: 'pass', duration: 14_700 },
  ];
  const lines = () =>
    buildConversationRows({
      sections: groupEventsIntoSections([...eventsStore.get().events]),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 120,
      viewportHeight: 40,
      streaming,
    }).rows.map(rowText);

  it('stands above the plan check from its first row and never moves while the review runs and settles', () => {
    resetWorkflow();
    const firstCheck = events.indexOf(planCheck);
    for (const event of events.slice(0, firstCheck)) addEvent(event);
    const before = lines();
    expect(before).not.toContain('Final review');
    for (const event of events.slice(firstCheck)) {
      addEvent(event);
      const rows = lines();
      const heading = rows.indexOf('Final review');
      expect(heading, event.type).toBeGreaterThan(-1);
      expect(rows.slice(0, heading - 1), event.type).toEqual(before);
      expect(rows.slice(heading + 1, heading + 3), event.type).toEqual([
        '',
        expect.stringMatching(
          /^Plan check K1 · node --test tests\/math\.test\.js · (running|passed)/,
        ),
      ]);
    }
    expect(lines().filter((row) => row.startsWith('Plan check K1'))).toHaveLength(1);
    resetWorkflow();
  });
});

describe('wrappedTextBlock', () => {
  it('wraps message rows at width minus their leading so nothing clips at the right edge', () => {
    const width = 20;
    const text = 'x'.repeat(width);
    const block = wrappedTextBlock({ keyPrefix: 'k', text, width, tone: 'text' });
    expect(block?.rowCount).toBe(2);
    const rows = block?.createRows(0, 2) ?? [];
    for (const row of rows) {
      const line = row.segments.map((segment) => segment.text).join('');
      expect(line.length).toBeLessThanOrEqual(wrapWidthFor('message', width));
    }
  });
});

describe('buildConversationRowsProjection section spacers', () => {
  it('inserts exactly one renderableUnits-0 one-row blank spacer between adjacent sections, none at the edges', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          makeImplementerGenerate({ status: 'done', file: 'a.ts', diff: '+ a', ts: 1 }),
          makeImplementerGenerate({ status: 'done', file: 'b.ts', diff: '+ b', ts: 2 }),
        ],
      },
    ];

    const projection = buildConversationRowsProjection({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });

    const spacerIndexes = projection.blocks
      .map((block, index) => (block.key.startsWith('spacer-') ? index : -1))
      .filter((index) => index >= 0);

    // Exactly one spacer, sitting strictly between the two section blocks — never first, never last,
    // so no dangling blank hangs above the input.
    expect(spacerIndexes).toHaveLength(1);
    const spacerIndex = spacerIndexes[0] ?? -1;
    expect(spacerIndex).toBeGreaterThan(0);
    expect(spacerIndex).toBeLessThan(projection.blocks.length - 1);

    const spacer = projection.blocks[spacerIndex];
    // One blank row gives the transcript a calmer one-row rhythm between sections.
    expect(spacer?.rowCount).toBe(1);
    // renderableUnits 0 keeps the spacer out of the new-event count and the auto-scroll math.
    expect(spacer?.renderableUnits).toBe(0);
  });
});

describe('buildConversationRowsProjection check lists', () => {
  const commands = ['loan', 'renewals', 'member', 'services'].map((name, index) => ({
    id: `V${index + 1}`,
    command: `node --test test/${name}.test.js`,
    reason: `Checks ${name}.`,
  }));
  const header: EngineEventOf<'review_checks'> = {
    type: 'review_checks',
    ts: 1,
    phase: 'final-review',
    scope: 'final',
    status: 'planned',
    commands,
    declined: [
      {
        target: 'npm run test:e2e',
        reason: 'It needs a browser, and the change touches no screen.',
      },
    ],
  };
  const checks: EngineEventOf<'full_suite'>[] = commands.map((command, index) => ({
    type: 'full_suite',
    ts: index + 2,
    phase: 'final-review',
    status: 'done',
    id: command.id,
    command: command.command,
    moment: 'pre-review',
    passed: true,
    duration: index === 1 || index === 3 ? 200 : 100,
  }));
  const drift: EngineEventOf<'drift_report'> = {
    type: 'drift_report',
    ts: 6,
    phase: 'final-review',
    passed: true,
    errorCount: 0,
    warningCount: 0,
  };
  const firstCheck: EngineEventOf<'full_suite'> = {
    type: 'full_suite',
    ts: 2,
    phase: 'final-review',
    status: 'done',
    id: 'V1',
    command: 'node --test a.js',
    moment: 'pre-review',
    passed: true,
  };
  const secondCheck: EngineEventOf<'full_suite'> = { ...firstCheck, ts: 3, id: 'V2' };
  const shortHeader: EngineEventOf<'review_checks'> = { ...header, declined: [] };

  function projectionFor(items: EngineEvent[], cols = 120) {
    return buildConversationRowsProjection({
      sections: [{ type: 'events', startIndex: 0, items }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols,
      viewportHeight: 20,
      streaming,
    });
  }

  function materialize(projection: ReturnType<typeof buildConversationRowsProjection>) {
    return materializeConversationRowsWindow({
      projection,
      windowStart: 0,
      windowEnd: projection.totalRows,
    });
  }

  it('stacks reviewer checks and drift between surrounding messages', () => {
    const projection = projectionFor([
      { type: 'user_message', ts: 0, phase: 'idle', text: 'Check the changes.' },
      header,
      ...checks,
      drift,
      { type: 'planner_text', ts: 7, phase: 'final-review', text: 'Review is ready.' },
    ]);
    const rows = materialize(projection);

    expect(rows.map(rowText)).toEqual([
      'Check the changes.',
      '',
      'Reviewer checks · chose 4 · declined 1',
      '  declined · npm run test:e2e · It needs a browser, and the change touches no screen.',
      'Reviewer check V1 · node --test test/loan.test.js · passed · 0.1s',
      'Reviewer check V2 · node --test test/renewals.test.js · passed · 0.2s',
      'Reviewer check V3 · node --test test/member.test.js · passed · 0.1s',
      'Reviewer check V4 · node --test test/services.test.js · passed · 0.2s',
      'Drift · clean',
      '',
      'Review is ready.',
    ]);
    expect(rows.filter((row) => row.kind === 'spacer')).toHaveLength(2);
    expect(rows.at(0)?.kind).not.toBe('spacer');
    expect(rows.at(-1)?.kind).not.toBe('spacer');
    expect(projection.renderableCount).toBe(8);
    expect(projection.totalRows).toBe(rows.length);
  });

  it('keeps adjacent checks without spacers and hangs the wrapped continuation by two columns', () => {
    const projection = projectionFor(
      [
        {
          ...firstCheck,
          command: 'npm run lint',
          status: 'refused',
          detail: 'runs the package script lint, and this run changed package.json',
        },
        {
          ...secondCheck,
          command: 'npx tsc --noEmit',
          passed: false,
          duration: 16_000,
        },
      ],
      79,
    );
    const rows = materialize(projection);

    expect(rows.map(rowText)).toEqual([
      'Reviewer check V1 · npm run lint · refused · runs the package script lint, ',
      '  and this run changed package.json',
      'Reviewer check V2 · npx tsc --noEmit · failed · 16.0s',
    ]);
    expect(rows.filter((row) => row.kind === 'spacer')).toEqual([]);
    expect(projection.totalRows).toBe(3);
    expect(projection.renderableCount).toBe(2);
    expect(
      materializeConversationRowsWindow({ projection, windowStart: 1, windowEnd: 3 }).map(rowText),
    ).toEqual([
      '  and this run changed package.json',
      'Reviewer check V2 · npx tsc --noEmit · failed · 16.0s',
    ]);
  });

  describe.each(['pre-review', 'brief', 'base', 'plan'] as const)('moment %s', (moment) => {
    it.each(['running', 'passed', 'failed', 'refused', 'not-run', 'stopped'] as const)(
      'stacks check rows for every moment and status: %s',
      (status) => {
        const check: EngineEventOf<'full_suite'> = {
          ...firstCheck,
          moment,
          status: status === 'passed' || status === 'failed' ? 'done' : status,
          passed: status === 'passed',
        };
        for (const withHeader of [true, false]) {
          const projection = projectionFor([
            ...(withHeader ? [shortHeader] : []),
            check,
            { ...check, id: 'V2' },
            drift,
          ]);
          const rows = materialize(projection);

          expect(rows.filter((row) => row.kind === 'spacer')).toEqual([]);
          expect(rows).toHaveLength(withHeader ? 4 : 3);
          expect(rows.at(-1)).toMatchObject({
            segments: [
              { text: 'Drift', tone: 'text' },
              { text: ' · ', tone: 'textDim' },
              { text: 'clean', tone: 'success' },
            ],
          });
          expect(projection.renderableCount).toBe(withHeader ? 4 : 3);
        }
      },
    );
  });

  it.each(['planning', 'implementing', 'validating-task', 'final-review', 'complete'] as const)(
    'stacks legacy checks without ids in phase %s',
    (phase) => {
      const legacy: EngineEventOf<'full_suite'> = {
        ...firstCheck,
        phase,
        id: undefined,
        stage: 'test',
      };
      const rows = materialize(projectionFor([legacy, { ...legacy, command: 'npm test' }, drift]));

      expect(rows.map(rowText)).toEqual([
        'Pre-review suite · node --test a.js · passed',
        'Pre-review suite · npm test · passed',
        'Drift · clean',
      ]);
      expect(rows.filter((row) => row.kind === 'spacer')).toEqual([]);
    },
  );

  it('keeps rowless events inside a check list', () => {
    const projection = projectionFor([
      shortHeader,
      makePlannerHeartbeat(),
      firstCheck,
      makePlannerStatus(),
      activity({ kind: 'session', label: 'native session opened' }),
      { type: 'planner_text', ts: 3, phase: 'final-review', content: 'markdown', text: '' },
      secondCheck,
      makePlannerHeartbeat(),
      drift,
    ]);

    expect(materialize(projection).map(rowText)).toEqual([
      'Reviewer checks · chose 4',
      'Reviewer check V1 · node --test a.js · passed',
      'Reviewer check V2 · node --test a.js · passed',
      'Drift · clean',
    ]);
    expect(projection.renderableCount).toBe(4);
  });

  it.each(['off', 'skipped', 'planned'] as const)(
    'joins drift after a header without commands: %s',
    (status) => {
      const projection = projectionFor([
        { ...shortHeader, status, commands: [], reason: 'No checks needed.' },
        drift,
      ]);
      const rows = materialize(projection);

      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.kind === 'spacer')).toEqual([]);
      if (status === 'planned') {
        expect(
          rows[0]?.segments
            .filter((segment) => segment.text !== 'Reviewer')
            .every((segment) => segment.tone === 'textDim'),
        ).toBe(true);
      } else {
        const state = status === 'off' ? 'off' : 'not\u00a0run';
        expect(rows[0]?.segments).toContainEqual({ text: state, tone: 'warning' });
        expect(
          rows[0]?.segments
            .filter((segment) => segment.text !== 'Reviewer' && segment.text !== state)
            .every((segment) => segment.tone === 'textDim'),
        ).toBe(true);
      }
      expect(rows.at(-1)).toMatchObject({
        segments: [
          { text: 'Drift', tone: 'text' },
          { text: ' · ', tone: 'textDim' },
          { text: 'clean', tone: 'success' },
        ],
      });
      expect(projection.renderableCount).toBe(2);
    },
  );

  it.each([60, 80, 120])(
    'materializes compact lists across wrapped row windows at %s columns',
    (cols) => {
      const projection = projectionFor(
        [
          {
            ...header,
            declined: [
              {
                target: 'npm run test:e2e',
                reason:
                  'This command needs a browser and a running server. The change only touches the loan calculations, so the reviewer chose the unit tests that check those calculations.',
              },
            ],
          },
          firstCheck,
          {
            ...secondCheck,
            status: 'not-run',
            detail:
              'This check needs a running server. Start the server, then run this command from the workspace to check the changed calculations.',
          },
          drift,
        ],
        cols,
      );
      const rows = materialize(projection);

      expect(rows.length).toBeGreaterThan(5);
      expect(rows.filter((row) => row.kind === 'spacer')).toEqual([]);
      expect(projection.totalRows).toBe(rows.length);
      for (const windowSize of [1, 3, 7]) {
        const windows: ConversationRow[] = [];
        for (let start = 0; start < projection.totalRows; start += windowSize) {
          windows.push(
            ...materializeConversationRowsWindow({
              projection,
              windowStart: start,
              windowEnd: Math.min(projection.totalRows, start + windowSize),
            }),
          );
        }
        expect(windows).toEqual(rows);
      }
    },
  );

  it.each<{ name: string; event: EngineEvent }>([
    {
      name: 'message',
      event: { type: 'user_message', ts: 3, phase: 'final-review', text: 'Check this too.' },
    },
    { name: 'activity batch', event: activity({ kind: 'read', label: 'reading a.ts' }) },
    {
      name: 'recovery row',
      event: {
        type: 'recovery_action_selected',
        ts: 3,
        phase: 'final-review',
        issueId: 'issue-1',
        reason: 'runner-usage-limit',
        action: 'retry-same-worker',
        seat: 'review',
      },
    },
    {
      name: 'validate row',
      event: {
        type: 'validate',
        ts: 3,
        phase: 'validating-task',
        taskId: taskId('T001'),
        status: 'done',
        passed: true,
        stages: { typecheck: true, lint: true, test: true },
      },
    },
    { name: 'task header', event: makeTaskStart() },
  ])('keeps spacers around a $name between checks', ({ event }) => {
    const boundaryRows = materialize(projectionFor([event]));
    const rows = materialize(projectionFor([shortHeader, firstCheck, event, secondCheck, drift]));

    expect(rows.map(rowText)).toEqual([
      'Reviewer checks · chose 4',
      'Reviewer check V1 · node --test a.js · passed',
      '',
      ...boundaryRows.map(rowText),
      '',
      'Reviewer check V2 · node --test a.js · passed',
      'Drift · clean',
    ]);
    expect(rows.filter((row) => row.kind === 'spacer')).toHaveLength(2);
  });

  it('keeps a spacer before a second review_checks header', () => {
    const rows = materialize(
      projectionFor([shortHeader, firstCheck, shortHeader, secondCheck, drift]),
    );

    expect(rows.map(rowText)).toEqual([
      'Reviewer checks · chose 4',
      'Reviewer check V1 · node --test a.js · passed',
      '',
      'Reviewer checks · chose 4',
      'Reviewer check V2 · node --test a.js · passed',
      'Drift · clean',
    ]);
    expect(rows.filter((row) => row.kind === 'spacer')).toHaveLength(1);
  });

  it('keeps a spacer before a check after drift ends the list', () => {
    const rows = materialize(projectionFor([firstCheck, drift, secondCheck, drift]));

    expect(rows.map(rowText)).toEqual([
      'Reviewer check V1 · node --test a.js · passed',
      'Drift · clean',
      '',
      'Reviewer check V2 · node --test a.js · passed',
      'Drift · clean',
    ]);
    expect(rows.filter((row) => row.kind === 'spacer')).toHaveLength(1);
  });

  it('keeps one spacer at each settled section boundary and none inside check lists', () => {
    const projection = buildConversationRowsProjection({
      sections: [
        { type: 'events', startIndex: 0, items: [shortHeader, firstCheck] },
        {
          type: 'settled-stage',
          startIndex: 2,
          items: [],
          summary: { stage: 'plan', feature: 'Check the changes', duration: 1000 },
        },
        {
          type: 'completed-task',
          startIndex: 3,
          items: [],
          summary: {
            id: 'T001',
            title: 'Update calculations',
            method: 'local',
            retries: 0,
            duration: 1000,
          },
        },
        { type: 'events', startIndex: 4, items: [secondCheck, drift] },
      ],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 120,
      viewportHeight: 20,
      streaming,
    });
    const rows = materialize(projection);

    expect(rows.map((row) => row.kind)).toEqual([
      'message',
      'message',
      'spacer',
      'summary',
      'spacer',
      'summary',
      'spacer',
      'message',
      'message',
    ]);
    expect(projection.renderableCount).toBe(6);
  });
});

describe('buildConversationRowsProjection event block cache', () => {
  it('caches settled bodies and replaces live task and activity markers on settlement', () => {
    resetEventBlockCache();
    const start = makeTaskStart({ title: 'Cached brief' });
    const narration: EngineEvent = {
      type: 'planner_text',
      ts: 1,
      phase: 'implementing',
      content: 'markdown',
      text: 'Retained **narration**.',
    };
    const activityEvent = activity({ phase: 'implementing', role: 'implementer' });
    const inputs = {
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 80,
      viewportHeight: 20,
      streaming,
    };
    const live = buildConversationRowsProjection({
      ...inputs,
      sections: groupEventsIntoSections([start, narration, activityEvent]),
    });
    expect(live.blocks.some((block) => block.activeRowKey !== undefined)).toBe(true);
    const done = [start, narration, activityEvent, makeTaskComplete()];
    const settled = buildConversationRowsProjection({
      ...inputs,
      sections: groupEventsIntoSections(done),
    });
    const appended = buildConversationRowsProjection({
      ...inputs,
      sections: groupEventsIntoSections([...done, makeTaskStart({ taskId: taskId('T002') })]),
    });
    const body = settled.blocks.filter(
      (block) => !block.key.startsWith('spacer-') && !block.key.startsWith('settled-'),
    );
    expect(body).toHaveLength(2);
    expect(body.every((block) => block.activeRowKey === undefined)).toBe(true);
    for (const block of body)
      expect(appended.blocks.find((candidate) => candidate.key === block.key)).toBe(block);
    expect(
      materializeConversationRowsWindow({
        projection: settled,
        windowStart: 0,
        windowEnd: settled.totalRows,
      })
        .map(rowText)
        .join('\n'),
    ).not.toContain('Cached brief');
  });
  it('reuses prior event blocks by identity on append', () => {
    resetEventBlockCache();

    const userMessage: EngineEventOf<'user_message'> = {
      type: 'user_message',
      ts: 0,
      phase: 'idle',
      text: 'Add dark-mode toggle',
    };
    const firstPlannerText: EngineEventOf<'planner_text'> = {
      type: 'planner_text',
      ts: 1,
      phase: 'analyzing',
      content: 'markdown',
      text: 'Looking into the request now.',
    };
    const secondPlannerText: EngineEventOf<'planner_text'> = {
      type: 'planner_text',
      ts: 2,
      phase: 'analyzing',
      content: 'markdown',
      text: 'Second update landed.',
    };

    const projectionFor = (items: EngineEvent[]) => {
      const sections: Section<EngineEvent>[] = [{ type: 'events', startIndex: 0, items }];
      return buildConversationRowsProjection({
        sections,
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 88,
        viewportHeight: 20,
        streaming,
      });
    };

    const first = projectionFor([userMessage, firstPlannerText]);
    const firstEventBlocks = first.blocks.filter((block) => !block.key.startsWith('spacer-'));

    const second = projectionFor([userMessage, firstPlannerText, secondPlannerText]);
    const secondEventBlocks = second.blocks.filter((block) => !block.key.startsWith('spacer-'));

    expect(secondEventBlocks[0]).toBe(firstEventBlocks[0]);
    expect(secondEventBlocks[1]).toBe(firstEventBlocks[1]);

    const incrementalText = materializeConversationRowsWindow({
      projection: second,
      windowStart: 0,
      windowEnd: second.totalRows,
    })
      .map(rowText)
      .join('\n');

    resetEventBlockCache();
    const fresh = projectionFor([userMessage, firstPlannerText, secondPlannerText]);
    const freshText = materializeConversationRowsWindow({
      projection: fresh,
      windowStart: 0,
      windowEnd: fresh.totalRows,
    })
      .map(rowText)
      .join('\n');

    expect(incrementalText).toBe(freshText);
  });
});

describe('one recovery reads as one block', () => {
  const at = { ts: 0, phase: 'implementing' } as const;
  const recovery = { ...at, issueId: 'issue-1', reason: 'checkout-changed' } as const;
  const halt: EngineEvent = {
    ...at,
    type: 'error',
    message: 'Your checkout changed under T002 — branch cli-budget-behaviour-fixes',
  };
  const prompted: EngineEvent = {
    ...recovery,
    type: 'recovery_prompted',
    taskId: taskId('T002'),
    files: [],
    affectedTaskIds: [],
    availableActions: ['retry-same-worker'],
    recommendedAction: 'retry-same-worker',
    headline: 'Your checkout changed under T002',
    resumeCommand: 'splitbrief continue',
  };
  const selected: EngineEvent = {
    ...recovery,
    type: 'recovery_action_selected',
    action: 'retry-same-worker',
    seat: 'build',
  };
  const reset: EngineEvent = { ...at, type: 'task_reset', taskId: taskId('T002') };
  const resolved: EngineEvent = {
    ...recovery,
    type: 'recovery_resolved',
    action: 'retry-same-worker',
    seat: 'build',
    outcome: 'retry-current-task',
    implementerProfile: 'default',
  };

  function transcript(items: EngineEvent[]): { lines: string[]; rows: ConversationRow[] } {
    const { rows } = buildConversationRows({
      sections: [{ type: 'events', startIndex: 0, items }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 100,
      viewportHeight: 30,
      streaming,
    });
    return { lines: rows.map((row) => rowText(row).trim()).filter((line) => line !== ''), rows };
  }

  it('keeps one Recovery row across an abandoned section and the next brief', () => {
    const start = makeTaskStart({ taskId: taskId('T002') });
    const next = makeTaskStart({ taskId: taskId('T003'), title: 'Next brief' });
    const { rows } = buildConversationRows({
      sections: groupEventsIntoSections([start, halt, prompted, selected, reset, resolved, next]),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 120,
      viewportHeight: 40,
      streaming,
    });
    const recoveryRows = rows.map(rowText).filter((line) => line.startsWith('Recovery'));
    expect(recoveryRows).toEqual([`Recovery  Try again${arrowSep()}T002 back to pending, retried`]);
  });

  it('gives the halt its error and folds selection, reset and outcome into one Recovery row', () => {
    const { lines } = transcript([halt, prompted, selected, reset, resolved]);

    expect(lines).toEqual([
      'Error',
      'Your checkout changed under T002 — branch cli-budget-behaviour-fixes',
      `Recovery  Try again${arrowSep()}T002 back to pending, retried`,
    ]);
  });

  it('folds a checkout halt whose headline carries its changes under the error that names them', () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({ id: 'T002' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } }).implementer,
      toolMessage: 'branch fix/implementer-never-runs-gates',
      attempts: 0,
      maxAttempts: 2,
      createdAt: '2026-10-07T05:54:04.413Z',
    });
    const { lines } = transcript([
      { ...halt, message: issue.message },
      { ...prompted, headline: formatRecoveryHeadline(issue) },
      selected,
      reset,
      resolved,
    ]);

    expect(lines).toEqual([
      'Error',
      'Repository changed under T002 · branch fix/implementer-never-runs-gates',
      `Recovery  Try again${arrowSep()}T002 back to pending, retried`,
    ]);
  });

  it('shows a recovery still being applied as its action alone', () => {
    const { lines } = transcript([halt, prompted, selected]);

    expect(lines.at(-1)).toBe('Recovery  Try again');
  });

  it.each([true, false])('shows one recovery then its seat switch with auto=%s', (auto) => {
    const headline = 'Balance spent on OpenCode CLI';
    const { lines } = transcript([
      { ...halt, message: headline },
      { ...prompted, reason: 'runner-usage-limit', headline, availableActions: ['switch-seat'] },
      { ...selected, reason: 'runner-usage-limit', action: 'switch-seat' },
      {
        ...at,
        type: 'seat_switched',
        seat: 'build',
        from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        to: { tool: 'opencode' },
        cause: 'runner-usage-limit',
        headline,
        auto,
        configRevision: 'test-revision',
      },
      { ...resolved, reason: 'runner-usage-limit', action: 'switch-seat' },
    ]);

    expect(lines.slice(0, auto ? 1 : 3)).toEqual(
      auto
        ? [`Recovery  ${headline}${arrowSep()}continued on fallback`]
        : ['Error', headline, `Recovery  Change BUILD model${arrowSep()}T002 resumed on new seat`],
    );
    expect(lines.at(auto ? 1 : 3)).toContain(
      `BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek${arrowSep()}OpenCode CLI`,
    );
    expect(lines.join(' ').includes('automatic fallback')).toBe(auto);
    expect(lines.join(' ').match(/Balance spent on OpenCode CLI/gu)).toHaveLength(auto ? 1 : 2);
  });

  it('keeps the prompted card as one quiet row when no error before it names the halt', () => {
    const { lines, rows } = transcript([prompted]);

    expect(lines).toEqual(['Recovery  Your checkout changed under T002']);
    const [row] = rows.filter((candidate) => rowText(candidate).trim() !== '');
    expect(row?.kind).toBe('card');
    expect(row?.segments[0]?.tone).toBe('warning');
  });

  it('folds a halt no error row names, and what was done about it, into one row', () => {
    const { lines } = transcript([prompted, prompted, selected, reset, resolved]);

    expect(lines).toEqual([
      `Recovery  Your checkout changed under T002${SOFT_SEP}Try again${arrowSep()}T002 back to pending, retried`,
    ]);
  });

  it('keeps a blocked action as its own error row', () => {
    const failed: EngineEvent = {
      ...recovery,
      type: 'recovery_action_failed',
      action: 'retry-same-worker',
      seat: 'build',
      message: 'worker unavailable',
    };
    const { lines, rows } = transcript([selected, failed]);

    expect(lines).toEqual([
      'Recovery  Try again',
      'Recovery  Try again blocked: worker unavailable',
    ]);
    const blocked = rows.find((row) => rowText(row).includes('blocked'));
    expect(blocked?.segments[0]?.tone).toBe('error');
  });

  it('heads a brief restarted by its recovery once', () => {
    const start: EngineEvent = {
      ...at,
      type: 'task_started',
      taskId: taskId('T002'),
      title: 'Wire the login route',
      index: 1,
      total: 3,
      file: 'src/login.ts',
      action: 'modify',
    };
    const { lines } = transcript([start, halt, prompted, selected, reset, resolved, start]);

    expect(lines.filter((line) => line.includes('Wire the login route'))).toHaveLength(1);
    expect(lines.at(-1)).toBe(`Recovery  Try again${arrowSep()}T002 back to pending, retried`);
  });

  it('heads a brief again when its recovery restarted it on another tool', () => {
    const start: EngineEvent = {
      ...at,
      type: 'task_started',
      taskId: taskId('T002'),
      title: 'Wire the login route',
      index: 1,
      total: 3,
      file: 'src/login.ts',
      action: 'modify',
      tool: 'opencode',
    };
    const { lines } = transcript([
      start,
      halt,
      prompted,
      selected,
      reset,
      resolved,
      { ...start, tool: 'codex' },
    ]);

    expect(lines.filter((line) => line.includes('Wire the login route'))).toHaveLength(2);
  });

  it('keeps only the resumed brief header active after a seat switch', () => {
    const start = makeTaskStart({
      taskId: taskId('T901'),
      tool: 'opencode',
      model: 'deepseek/deepseek-flash',
    });
    const restarted = { ...start, ts: 5, model: 'opencode-go/deepseek-v4.1-flash', axes: ['high'] };
    const { rows } = buildConversationRows({
      sections: groupEventsIntoSections([start, restarted]),
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 200,
      viewportHeight: 40,
      streaming,
    });
    const headers = rows.filter((row) => rowText(row).startsWith('T901'));
    expect(headers).toHaveLength(2);
    expect(headers.map((row) => row.kind)).toEqual(['section', 'task-header']);
    expect(headers[0]?.segments.every((segment) => segment.tone === 'textDim')).toBe(true);
  });

  it.each([
    ['opencode', 'opencode-go/deepseek-v4.1-flash', 'model'],
    ['codex', 'gpt-6.1-sol', 'tool'],
  ])('describes a manual switch to %s / %s as a change of %s', (tool, model, changed) => {
    const { lines } = transcript([
      halt,
      prompted,
      { ...selected, action: 'switch-seat' },
      {
        ...at,
        type: 'seat_switched',
        seat: 'build',
        from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        to: { tool, model },
        cause: 'checkout-changed',
        auto: false,
        configRevision: 'manual-switch',
      },
      { ...resolved, action: 'switch-seat' },
    ]);
    expect(lines.filter((line) => line.startsWith('Recovery'))).toEqual([
      `Recovery  Change BUILD ${changed}${arrowSep()}T002 resumed on new seat`,
    ]);
  });

  it.each([
    ['continued', 'continued', 'success'],
    ['retry-current-task', 'retried', 'success'],
    ['skipped-current-task', 'skipped', 'warning'],
    ['aborted', 'run ended', 'warning'],
  ] as const)('tones an outcome %s as %s', (outcome, outcomeWords, tone) => {
    const { lines, rows } = transcript([
      { ...recovery, type: 'recovery_resolved', action: 'retry-same-worker', outcome },
    ]);

    expect(lines).toEqual([`Recovery  Try again${arrowSep()}${outcomeWords}`]);
    expect(rows[0]?.segments[0]?.tone).toBe(tone);
  });

  it('does not call a brief the planner stopped early one that failed', () => {
    const { lines } = transcript([
      { ...selected, reason: 'retry-exhausted', phase: 'escalating' } as EngineEvent,
    ]);

    expect(lines).toEqual(['Recovery  Try again']);
    expect(lines.join('\n')).not.toMatch(/exhausted/i);
  });

  describe('a seat swap names the seat the halt stopped', () => {
    function swapLines(seat: 'plan' | 'build' | 'review' | undefined): string[] {
      const base = {
        ...at,
        phase: 'planning',
        issueId: 'issue-1',
        reason: 'runner-usage-limit',
        action: 'switch-seat',
        ...(seat !== undefined && { seat }),
      } as const;
      return transcript([
        { type: 'recovery_action_selected', ...base },
        { type: 'recovery_action_failed', ...base, message: 'codex is not ready' },
        { type: 'recovery_resolved', ...base, outcome: 'continued' },
      ]).lines;
    }

    it.each([
      ['plan', 'Change PLAN tool'],
      ['build', 'Change BUILD tool'],
      ['review', 'Change REVIEW tool'],
    ] as const)('on the %s seat', (seat, label) => {
      expect(swapLines(seat)).toEqual([
        `Recovery  ${label}`,
        `Recovery  ${label} blocked: codex is not ready`,
        `Recovery  ${label}${arrowSep()}continued`,
      ]);
    });

    it('names no seat on an event recorded before the seat was', () => {
      expect(swapLines(undefined)).toEqual([
        'Recovery  Change tool',
        'Recovery  Change tool blocked: codex is not ready',
        `Recovery  Change tool${arrowSep()}continued`,
      ]);
    });
  });

  it('names a reset outside a recovery in one row', () => {
    const { lines } = transcript([reset]);

    expect(lines).toEqual(['Task reset  T002 back to pending']);
  });
});
