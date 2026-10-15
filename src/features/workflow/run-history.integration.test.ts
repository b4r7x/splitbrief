import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { createElement, Fragment } from 'react';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { groupEventsIntoSections } from '../../core/sections/event-sections.js';
import { ConversationRowView } from './components/conversation-flow/row-view.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { arrowSep } from '../../core/separators.js';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  makeRunnerCallStarted,
  makeRunnerCallCompleted,
} from '#testing/helpers/events/runner-call.js';
import { makeReviewFixInsertedEvents, makeTaskStart } from '#testing/helpers/events/task.js';
import { taskId } from '../../core/schemas/task.js';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import { createEventBus } from '../../engine/events/bus.js';
import { toEngineEventEntry } from '../../core/sessions/log-writer.js';
import { eventRows, buildConversationRows } from '#testing/helpers/event-rows.js';
import { rowText } from './conversation-rows/row-format/rows.js';
import { addEvent } from '../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../stores/workflow/actions/reset.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { selectRunningBrief, tasksStore } from '../../stores/workflow/tasks.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
import { operationsStore } from '../../stores/workflow/operations/state.js';
import { hydrateRun, readRunHistory } from './run-history.js';

let projectDir = '';
const SESSION_ID = 'run-history-session';

const RUN: readonly EngineEvent[] = [
  { type: 'workflow_started', ts: 1_000, phase: 'planning', feature: 'replay me' },
  {
    type: 'task_started',
    ts: 2_000,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Add validator',
    index: 0,
    total: 2,
    file: 'src/validate.ts',
    action: 'create',
  },
  {
    type: 'task_completed',
    ts: 3_000,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Add validator',
    method: 'local',
    retries: 0,
    duration: 1_000,
  },
];

function savedState(): WorkflowState {
  return {
    stateVersion: 1,
    phase: 'implementing',
    feature: 'replay me',
    currentTaskIndex: 1,
    attempt: 0,
    tasks: [
      makeTask({ id: 'T001', status: 'done', title: 'Add validator' }),
      makeTask({ id: 'T002', status: 'pending', title: 'Wire it in' }),
    ],
    plannerSessionId: null,
    startedAt: new Date(1_000).toISOString(),
    tokenUsage: makeUsage({ plannerInput: 400, plannerOutput: 100 }),
    plannerTool: 'claude-code',
    implementerTool: 'ollama',
    awaitingContinue: false,
    messageQueue: [],
  };
}

function writeLog(events: readonly EngineEvent[]): void {
  const dir = sessionDir(projectDir, SESSION_ID);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((event) => `${JSON.stringify(toEngineEventEntry(event))}\n`).join('');
  writeFileSync(join(dir, SESSION_LOG_FILE), lines);
}

beforeEach(() => {
  forceUnicodeGlyphs();
  projectDir = createTempDir('run-history');
  resetWorkflow();
});

afterEach(() => {
  resetWorkflow();
  if (projectDir) cleanupTempDir(projectDir);
  projectDir = '';
});

function historyRows(events: EngineEvent[]): string[] {
  return buildConversationRows({
    sections: groupEventsIntoSections(events),
    expandedDiffs: new Set(),
    expandedActivityBatches: new Set(),
    cols: 200,
    viewportHeight: 50,
    streaming: { taskId: null, lines: [], active: false },
  }).rows.map(rowText);
}

describe('hydrateRun', () => {
  it('restores both historical smoke briefs from their taskless implementer reports', async () => {
    const briefs = [
      {
        id: taskId('T001'),
        file: 'src/text.js',
        test: 'test/text.test.js',
        title: 'Add wordCount to src/text.js',
        narration:
          "Added `wordCount(value)` as a named export in `src/text.js`, matching `compactWhitespace`'s validation style, and extended `test/text.test.js` with the required cases.",
        duration: 15409,
      },
      {
        id: taskId('T002'),
        file: 'src/preview.js',
        test: 'test/preview.test.js',
        title: 'Add optional suffix to truncate in src/preview.js',
        narration:
          'I updated `truncate` with the optional `suffix` parameter and added the requested node:test cases.',
        duration: 15018,
      },
    ];
    const history = briefs.flatMap((brief, index): EngineEvent[] => [
      {
        type: 'task_started',
        ts: 2000 + index * 1000,
        phase: 'implementing',
        taskId: brief.id,
        title: brief.title,
        index,
        total: 2,
        file: brief.file,
        files: [brief.file, brief.test],
        action: 'modify',
      },
      {
        type: 'planner_text',
        ts: 2100 + index * 1000,
        phase: 'implementing',
        role: 'implementer',
        content: 'markdown',
        text: `${brief.narration}\n\n${JSON.stringify({ status: 'done', filesChanged: [brief.file, brief.test], touchedNotSuggested: [], notes: null, decisions: [] })}`,
      },
      {
        type: 'implementer_generate_done',
        ts: 2200 + index * 1000,
        phase: 'implementing',
        taskId: brief.id,
        file: brief.file,
        duration: brief.duration,
      },
      {
        type: 'task_completed',
        ts: 2300 + index * 1000,
        phase: 'implementing',
        taskId: brief.id,
        title: brief.title,
        method: 'local',
        retries: 0,
        duration: brief.duration,
        tool: 'opencode',
        model: 'opencode-go/deepseek-v4.1-flash',
      },
    ]);
    writeLog(history);
    await hydrateRun(makeRunRecord({ ref: { projectDir, sessionId: SESSION_ID } }));
    const replay = eventsStore.get().events;
    expect(
      replay
        .filter((event) => event.type === 'implementer_generate_done')
        .map((event) => event.files),
    ).toEqual(briefs.map((brief) => [brief.file, brief.test]));
    const replayRows = historyRows(replay);
    for (const brief of briefs) {
      const filesLine = replayRows.filter((row) => row.startsWith(`${brief.file} ·`));
      expect(filesLine).toHaveLength(1);
      expect(filesLine[0]).toContain(`${brief.file} · ${brief.test}`);
      expect(filesLine[0]?.split(brief.test)).toHaveLength(2);
    }
    expect(replayRows.filter((row) => row === 'Report  done · 0 decisions')).toHaveLength(2);
    resetWorkflow();
    for (const event of history) {
      const brief =
        event.type === 'implementer_generate_done'
          ? briefs.find((brief) => brief.id === event.taskId)
          : undefined;
      addEvent(
        event.type === 'implementer_generate_done' && brief !== undefined
          ? { ...event, files: [brief.file, brief.test] }
          : event,
      );
    }
    expect(historyRows(eventsStore.get().events)).toEqual(replayRows);
  });

  it('keeps the recorded target when no report names changed files and clears reports on restart', async () => {
    const start = RUN[1];
    if (start?.type !== 'task_started') throw new Error('Missing task start');
    writeLog([
      start,
      {
        type: 'planner_text',
        ts: 2100,
        phase: 'implementing',
        role: 'implementer',
        text: '{"status":"done","filesChanged":["src/old.ts"],"touchedNotSuggested":[],"notes":null,"decisions":[]}',
      },
      { ...start, ts: 2200 },
      {
        type: 'implementer_generate_done',
        ts: 2300,
        phase: 'implementing',
        taskId: start.taskId,
        file: start.file,
        duration: 100,
      },
    ]);
    await hydrateRun(makeRunRecord({ ref: { projectDir, sessionId: SESSION_ID } }));
    expect(
      eventsStore.get().events.find((event) => event.type === 'implementer_generate_done'),
    ).not.toHaveProperty('files');
    expect(historyRows(eventsStore.get().events)).toContain('src/validate.ts');
  });

  it('settles a truncated review on resume before T002 starts and finishes its call', async () => {
    writeLog([
      ...RUN,
      {
        type: 'review_started',
        ts: 4_000,
        phase: 'implementing',
        scope: 'task',
        afterTaskId: 'T001',
        tool: 'codex',
      },
    ]);
    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );
    expect(operationsStore.get().active).toMatchObject({ role: 'review', status: 'running' });
    addEvent({ type: 'workflow_resumed', ts: 5_000, phase: 'implementing' });
    addEvent(makeTaskStart({ ts: 6_000, taskId: taskId('T002'), index: 1 }));
    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().reviewStage).toBeNull();
    addEvent(makeRunnerCallStarted({ ts: 7_000, callId: 't002', taskId: taskId('T002') }));
    addEvent(
      makeRunnerCallCompleted({
        ts: 8_000,
        callId: 't002',
        taskId: taskId('T002'),
        startedAt: 7_000,
        endedAt: 8_000,
        durationMs: 1_000,
      }),
    );
    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().reviewStage).toBeNull();
    expect([...operationsStore.get().byCallId.values()].some((op) => op.status === 'running')).toBe(
      false,
    );
    expect(operationsStore.get().last).toMatchObject({
      callId: 't002',
      taskId: 'T002',
      role: 'implementer',
      status: 'completed',
    });
  });

  it('lets saved state supply inserted order for old logs before the second fix starts', async () => {
    writeLog(makeReviewFixInsertedEvents(false));
    const state: WorkflowState = {
      ...savedState(),
      currentTaskIndex: 4,
      tasks: ['T001', 'T002', 'T003', 'T004', 'T006', 'T007', 'T005'].map((id, index) =>
        makeTask({ id, status: index < 4 ? 'done' : index === 4 ? 'in_progress' : 'pending' }),
      ),
    };
    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state },
      }),
    );
    expect(tasksStore.get().tasks.map((task) => task.id)).toEqual(
      state.tasks.map((task) => task.id),
    );
    expect(tasksStore.get().taskMap.get('T007')?.status).toBe('pending');
    expect(selectRunningBrief(tasksStore.get(), 'implementing')).toMatchObject({
      current: { id: 'T006' },
      next: { id: 'T007' },
    });
  });
  it('replays answered questions with their attached files once, matching the live transcript', async () => {
    const answer: EngineEventOf<'user_message'> = {
      type: 'user_message',
      ts: 1_100,
      phase: 'planning',
      text: '1. Which module?\n@/Users/me/notes/brief.md',
      qa: [{ question: 'Which module?', answer: '@/Users/me/notes/brief.md' }],
      attachedInputs: [{ path: '/Users/me/notes/brief.md', kind: 'text' }],
    };
    const log = [...RUN.slice(0, 1), answer];
    writeLog(log);
    appendFileSync(
      join(sessionDir(projectDir, SESSION_ID), SESSION_LOG_FILE),
      `${JSON.stringify({
        kind: 'message',
        ts: new Date(answer.ts).toISOString(),
        role: 'user',
        phase: answer.phase,
        text: answer.text,
        qa: answer.qa,
      })}\n`,
    );
    for (const event of log) addEvent(event);
    const live = eventRows({
      event: answer,
      globalIndex: 1,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming: { taskId: null, lines: [], active: false } },
    }).map((row) => rowText(row).trim());
    resetWorkflow();

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );
    const replayed = eventsStore.get().events.flatMap((event, globalIndex) =>
      eventRows({
        event,
        globalIndex,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming: { taskId: null, lines: [], active: false } },
      }).map((row) => rowText(row).trim()),
    );

    expect(replayed).toEqual(live);
    expect(replayed).toEqual([
      'Answered · 1 question',
      '1. Which module?',
      'You → @/Users/me/notes/brief.md',
      'Attached files · 1',
      'text · /Users/me/notes/brief.md',
    ]);
  });

  it('restores the first request with every attached file in the transcript', async () => {
    writeLog([
      ...RUN.slice(0, 1),
      {
        type: 'user_message',
        ts: 1_100,
        phase: 'idle',
        text: 'replay me',
        attachedInputs: [
          { path: '/Users/dev/briefs/feature.md', kind: 'text' },
          { path: '/Users/dev/Desktop/receiving-flow.png', kind: 'image' },
        ],
      },
      ...RUN.slice(1),
    ]);

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );
    const { rows } = buildConversationRows({
      sections: [{ type: 'events', startIndex: 0, items: [...eventsStore.get().events] }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 80,
      viewportHeight: 20,
      streaming: { taskId: null, lines: [], active: false },
    });
    const lines = rows.map((row) => rowText(row).trim());
    const header = lines.indexOf('Attached files · 2');

    expect(header).toBeGreaterThan(-1);
    expect(lines.slice(header, header + 3)).toEqual([
      'Attached files · 2',
      'text · /Users/dev/briefs/feature.md',
      'image · /Users/dev/Desktop/receiving-flow.png',
    ]);
  });

  it('settles a fix check cut by Stop before a replayed retry and an in-place continuation', async () => {
    const fix: EngineEventOf<'full_suite'> = {
      type: 'full_suite',
      ts: 4_000,
      phase: 'implementing',
      id: 'V1',
      moment: 'brief',
      command: 'npm run test-ci',
      status: 'running',
    };
    const log: EngineEvent[] = [
      ...RUN,
      fix,
      { type: 'turn_interrupted', ts: 5_000, phase: 'implementing', source: 'user' },
      {
        type: 'task_retry',
        ts: 3_000_000,
        phase: 'implementing',
        taskId: taskId('T002'),
        attempt: 2,
        maxRetries: 3,
        error: 'retry after Stop',
      },
    ];
    writeLog(log);
    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );
    expect(operationsStore.get().suiteStage).toBeNull();
    expect(operationsStore.get().validationStage).toBeNull();
    expect(eventsStore.get().events).toContainEqual({ ...fix, status: 'stopped' });
    const rows = eventsStore.get().events.flatMap((event, globalIndex) =>
      eventRows({
        event,
        globalIndex,
        expanded: false,
        ctx: {
          width: 120,
          viewportRows: 40,
          streaming: { taskId: null, lines: [], active: false },
        },
      }),
    );
    const text = rows.map(rowText).join('\n');
    expect(text).toContain('Fix check V1 · npm run test-ci · stopped');
    expect(text).not.toContain('Fix check V1 · npm run test-ci · running');
    addEvent({ type: 'workflow_resumed', ts: 3_001_000, phase: 'implementing' });
    expect(operationsStore.get().suiteStage).toBeNull();
    addEvent({ ...fix, ts: 3_002_000 });
    expect(operationsStore.get().suiteStage?.stageStartedTs).toBe(3_002_000);
  });

  it('hydrates the task and final review rows in live order with frozen durations', async () => {
    const seat = { tool: 'codex', model: 'gpt-6.1-sol', axes: ['high'] };
    const log: EngineEvent[] = [
      ...RUN,
      {
        type: 'review_started',
        ts: 4_000,
        phase: 'implementing',
        scope: 'task',
        afterTaskId: 'T001',
        ...seat,
      },
      {
        type: 'review_completed',
        ts: 53_000,
        phase: 'implementing',
        scope: 'task',
        afterTaskId: 'T001',
        verdict: 'pass',
        findings: { blocking: 0, minor: 0 },
        duration: 49_000,
        ...seat,
      },
      {
        type: 'task_started',
        ts: 54_000,
        phase: 'implementing',
        taskId: taskId('T002'),
        title: 'Wire it in',
        file: 'src/wire.ts',
        action: 'modify',
        index: 1,
        total: 2,
      },
      {
        type: 'task_completed',
        ts: 55_000,
        phase: 'implementing',
        taskId: taskId('T002'),
        title: 'Wire it in',
        method: 'local',
        retries: 0,
        duration: 1_000,
      },
      {
        type: 'review_started',
        ts: 56_000,
        phase: 'implementing',
        scope: 'task',
        afterTaskId: 'T002',
        ...seat,
      },
      {
        type: 'review_completed',
        ts: 105_000,
        phase: 'implementing',
        scope: 'task',
        afterTaskId: 'T002',
        verdict: 'fail',
        findings: { blocking: 1, minor: 0 },
        duration: 49_000,
        ...seat,
      },
      {
        type: 'review_fix_started',
        ts: 106_000,
        phase: 'implementing',
        cycle: 1,
        taskIds: [taskId('T003')],
      },
      {
        type: 'task_started',
        ts: 107_000,
        phase: 'implementing',
        taskId: taskId('T003'),
        title: 'Fix validator',
        file: 'src/validate.ts',
        action: 'modify',
        index: 2,
        total: 3,
      },
      {
        type: 'task_completed',
        ts: 108_000,
        phase: 'implementing',
        taskId: taskId('T003'),
        title: 'Fix validator',
        method: 'local',
        retries: 0,
        duration: 1_000,
      },
      { type: 'review_started', ts: 109_000, phase: 'final-review', scope: 'final', ...seat },
      {
        type: 'review_completed',
        ts: 171_000,
        phase: 'final-review',
        scope: 'final',
        verdict: 'pass',
        findings: { blocking: 0, minor: 0 },
        duration: 62_000,
        ...seat,
      },
      { type: 'workflow_complete', ts: 172_000, phase: 'complete', review: 'passed' },
    ];
    const transcript = () => {
      const sections = groupEventsIntoSections([...eventsStore.get().events]);
      const { rows } = buildConversationRows({
        sections,
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: 120,
        viewportHeight: 40,
        streaming: { taskId: null, lines: [], active: false },
      });
      const ui = renderFeature(
        createElement(
          Fragment,
          null,
          ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
        ),
        { cols: 120, rows: 40 },
      );
      const lines = stripAnsiStyles(ui.lastFrame())
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^[●✗×] (?:T\d|Review |Final review )/u.test(line));
      ui.unmount();
      return {
        lines,
        summaries: sections.flatMap((section) =>
          section.type === 'settled-stage' && section.summary.stage === 'review'
            ? [section.summary]
            : [],
        ),
      };
    };
    writeLog(log);
    for (const event of log) addEvent(event);
    const live = transcript();
    expect(live.lines.filter((line) => /review/i.test(line))).toEqual([
      '● Review T001 passed  49.0s',
      '✗ Review T002 failed  1 blocking · fixes T003 · 49.0s',
      '● Final review passed  1m 2s',
    ]);
    resetWorkflow();
    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: {
          kind: 'loaded',
          state: {
            ...savedState(),
            phase: 'complete',
            tasks: [
              ...savedState().tasks.map((task) => ({ ...task, status: 'done' as const })),
              makeTask({ id: 'T003', title: 'Fix validator', status: 'done' }),
            ],
          },
        },
      }),
    );
    expect(transcript()).toEqual(live);
  });

  it('puts the stores where a live run of the same log would have left them', async () => {
    writeLog(RUN);
    for (const event of RUN) addEvent(event);
    const live = {
      events: eventsStore.get().events.map((event) => event.type),
      tasks: tasksStore.get().taskMap.get('T001')?.status,
      phase: lifecycleStore.get().phase,
    };
    resetWorkflow();

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    expect(eventsStore.get().events.map((event) => event.type)).toEqual([
      'replay_started',
      ...live.events,
      'replay_complete',
    ]);
    expect(tasksStore.get().taskMap.get('T001')?.status).toBe(live.tasks);
    expect(lifecycleStore.get().phase).toBe(live.phase);
  });

  it('lays the saved state over the replay: the brief list and the spend come from it', async () => {
    writeLog(RUN);

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    expect(tasksStore.get().totalTasks).toBe(2);
    expect(tasksStore.get().taskMap.get('T002')?.status).toBe('pending');
    expect(tokensStore.get().tokenUsage?.plannerInput).toBe(400);
    expect(lifecycleStore.get().status).toBe('paused');
  });

  it('replaces whatever run was on screen before it', async () => {
    addEvent({ type: 'workflow_started', ts: 500, phase: 'planning', feature: 'the other run' });
    writeLog(RUN);

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    const texts = JSON.stringify(eventsStore.get().events);
    expect(texts).not.toContain('the other run');
    expect(texts).toContain('replay me');
  });

  it('keeps each gate approval in the replayed history and draws no row for it', async () => {
    const approvals: readonly EngineEvent[] = [
      { type: 'spec_approved', ts: 1_200, phase: 'reviewing-spec' },
      { type: 'plan_approved', ts: 1_400, phase: 'reviewing-plan' },
      { type: 'briefs_approved', ts: 1_600, phase: 'reviewing-briefs' },
    ];
    writeLog([...RUN.slice(0, 1), ...approvals, ...RUN.slice(1)]);

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    expect(eventsStore.get().events.filter((event) => event.type.endsWith('_approved'))).toEqual(
      approvals,
    );
    const rows = approvals.flatMap((event, globalIndex) =>
      eventRows({
        event,
        globalIndex,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming: { taskId: null, lines: [], active: false } },
      }),
    );
    expect(rows).toEqual([]);
    expect(lifecycleStore.get().phase).toBe('implementing');
  });

  it('shows the call a crashed process left open as interrupted, and its brief as no longer working', async () => {
    const T002 = taskId('T002');
    const call = { taskId: T002, callId: 'implementer-2', role: 'implementer' } as const;
    writeLog([
      ...RUN,
      makeTaskStart({ taskId: T002, title: 'Wire it in', file: 'src/form.ts', ts: 4_000 }),
      {
        type: 'implementer_generate_running',
        ts: 4_100,
        phase: 'implementing',
        taskId: T002,
        file: 'src/form.ts',
      },
      makeRunnerCallStarted({ ...call, ts: 4_200 }),
    ]);
    const interrupted = {
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'interrupted' } },
      resumeAt: { kind: 'brief', taskId: T002, attempt: 0 },
    } as const;
    const paused = {
      ...interrupted,
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
    } as const;

    for (const [status, cut] of [
      [interrupted, 1],
      [paused, 0],
    ] as const) {
      await hydrateRun(
        makeRunRecord({
          ref: { projectDir, sessionId: SESSION_ID },
          hydration: { kind: 'loaded', state: savedState() },
          status,
        }),
      );
      const events = eventsStore.get().events;
      expect(events.at(-1)?.type).toBe('replay_complete');
      expect(
        events.filter((event) => event.type === 'runner_call_activity' && event.kind === 'error'),
      ).toHaveLength(cut);
      const rows = historyRows(events).join('\n');
      expect(rows.includes('working on')).toBe(cut === 0);
      if (cut === 1) expect(rows).toContain('current turn interrupted: SPLITBRIEF exited');
    }
  });

  it('shows a run whose state cannot be read as the log alone', async () => {
    writeLog(RUN);

    await hydrateRun(makeRunRecord({ ref: { projectDir, sessionId: SESSION_ID } }));

    // Everything the events carry still replays; only what lives on the state that could not be
    // read — the brief the run never started, and its token usage — is absent.
    expect(eventsStore.get().events.length).toBe(RUN.length + 2);
    expect(tasksStore.get().totalTasks).toBe(2);
    expect(tasksStore.get().taskMap.get('T001')?.status).toBe('done');
    expect(tasksStore.get().taskMap.get('T002')).toBeUndefined();
    expect(tokensStore.get().tokenUsage).toBeNull();
  });
});

describe('hydrateRun replaying a seat swap', () => {
  function writeRawLog(lines: readonly string[]): void {
    const dir = sessionDir(projectDir, SESSION_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SESSION_LOG_FILE), lines.map((line) => `${line}\n`).join(''));
  }

  async function replayedTranscript(): Promise<string> {
    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );
    return transcript();
  }

  function transcript(cols = 80): string {
    const { rows } = buildConversationRows({
      sections: [{ type: 'events', startIndex: 0, items: [...eventsStore.get().events] }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols,
      viewportHeight: 20,
      streaming: { taskId: null, lines: [], active: false },
    });
    return rows.map(rowText).join('\n');
  }

  it.each([true, false])(
    'renders the same recovery and switch live and replayed with auto=%s',
    async (auto) => {
      const base = {
        ts: 1_000,
        phase: 'implementing',
        issueId: 'balance-1',
        reason: 'runner-usage-limit',
      } as const;
      const headline = 'Balance spent on OpenCode CLI';
      const log: EngineEvent[] = [
        { type: 'error', ts: 500, phase: 'implementing', message: headline },
        {
          ...base,
          type: 'recovery_prompted',
          headline,
          files: [],
          affectedTaskIds: [],
          availableActions: ['switch-seat'],
          recommendedAction: 'switch-seat',
          resumeCommand: 'splitbrief continue',
        },
        { ...base, type: 'recovery_action_selected', action: 'switch-seat', seat: 'build' },
        {
          type: 'seat_switched',
          ts: 2_000,
          phase: 'implementing',
          seat: 'build',
          from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
          to: { tool: 'opencode' },
          cause: base.reason,
          headline,
          auto,
          configRevision: 'test-revision',
        },
        {
          ...base,
          type: 'recovery_resolved',
          action: 'switch-seat',
          seat: 'build',
          outcome: 'retry-current-task',
        },
      ];
      writeLog(log);
      const replayed = await replayedTranscript();
      const replayedWide = transcript(120);

      resetWorkflow();
      const bus = createEventBus();
      bus.subscribe(addEvent);
      for (const event of log) bus.publish(event);

      expect(transcript()).toBe(replayed);
      expect(transcript(120)).toBe(replayedWide);
      expect(replayedWide).toContain(
        `BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek${arrowSep()}OpenCode CLI${auto ? ' · automatic fallback' : ''}`,
      );
      expect(
        replayed
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      ).toEqual(
        auto
          ? [
              `Recovery  ${headline}${arrowSep()}continued on fallback`,
              `BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek${arrowSep()}OpenCode CLI`,
              'automatic fallback',
            ]
          : [
              'Error',
              headline,
              `Recovery  Change BUILD model${arrowSep()}continued on new seat`,
              `BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek${arrowSep()}OpenCode CLI`,
              headline,
            ],
      );
    },
  );

  it('names no seat for a swap a log recorded before the seat was on the event', async () => {
    // Written by a build whose recovery events carried no seat.
    writeRawLog([
      '{"kind":"event","ts":"2026-09-01T10:00:00.000Z","type":"recovery_action_selected","phase":"planning","data":{"issueId":"rec-1","reason":"runner-usage-limit","action":"switch-seat"}}',
      '{"kind":"event","ts":"2026-09-01T10:00:01.000Z","type":"recovery_resolved","phase":"planning","data":{"issueId":"rec-1","reason":"runner-usage-limit","action":"switch-seat","outcome":"continued"}}',
    ]);

    const text = await replayedTranscript();

    expect(text).toBe(`Recovery  Change tool${arrowSep()}continued`);
    expect(text).not.toContain('Change BUILD tool');
  });

  it('names the seat a swap recorded', async () => {
    const base = {
      ts: 1_000,
      phase: 'planning',
      issueId: 'rec-1',
      reason: 'runner-usage-limit',
      action: 'switch-seat',
      seat: 'plan',
    } as const;
    writeLog([
      { type: 'recovery_action_selected', ...base },
      { type: 'recovery_resolved', ...base, outcome: 'continued' },
    ]);

    const text = await replayedTranscript();

    expect(text).toBe(`Recovery  Change PLAN tool${arrowSep()}continued`);
  });
});

describe('readRunHistory', () => {
  it('reads without touching a store, and the run lands only when it is published', async () => {
    addEvent({ type: 'workflow_started', ts: 500, phase: 'planning', feature: 'the other run' });
    writeLog(RUN);
    const stores = [eventsStore, tasksStore, lifecycleStore, tokensStore];
    const before = stores.map((store) => store.get());

    const publish = await readRunHistory(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    stores.forEach((store, index) => {
      expect(store.get()).toBe(before[index]);
    });

    publish();

    const texts = JSON.stringify(eventsStore.get().events);
    expect(texts).not.toContain('the other run');
    expect(texts).toContain('replay me');
    expect(tasksStore.get().totalTasks).toBe(2);
    expect(tokensStore.get().tokenUsage?.plannerInput).toBe(400);
    expect(lifecycleStore.get().status).toBe('paused');
  });
});
