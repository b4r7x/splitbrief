import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../../core/schemas/session-log.js';
import { createSessionLogAppender, toEngineEventEntry } from '../../core/sessions/log-writer.js';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { boundEngineEventForConsumer } from './bound.js';
import { readRunEvents } from './replay.js';
import { parseEngineEvent } from './schema.js';
import type { EngineEvent } from './types.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { attachedMessage, expectCompactMessage } from '#testing/helpers/user-message.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createJsonlSink } from './sinks/jsonl.js';
import { recordSteer } from '../orchestrator/continuation.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';

const TS = 1_764_000_000_000;
const REPO_ROOT = join(import.meta.dirname, '../../..');
const LEGACY_FIXTURE = join(REPO_ROOT, 'testing/fixtures/session-log/legacy.jsonl');

const callContext = {
  callId: 'call-1',
  role: 'implementer',
  backendKind: 'cli',
  sequence: 1,
} as const;

const terminalFields = {
  startedAt: TS,
  endedAt: TS + 10,
  durationMs: 10,
  usage: null,
  nativeSessionId: null,
} as const;

const tokenUsage = {
  plannerInput: 120,
  plannerOutput: 34,
  implementerInput: 90,
  implementerOutput: 21,
  escalationInput: 0,
  escalationOutput: 0,
  reviewerInput: 0,
  reviewerOutput: 0,
} as const;

const SAMPLES: Record<string, Record<string, unknown>> = {
  workflow_started: { phase: 'researching', feature: 'add a replay path' },
  workflow_resumed: { phase: 'implementing' },
  workflow_complete: { phase: 'complete', review: 'passed', blocking: 0 },
  workflow_cancelled: { phase: 'implementing', reason: 'user_cancelled' },
  turn_interrupted: {
    phase: 'reviewing-plan',
    source: 'user',
    at: 'boundary',
    step: { kind: 'gate', gate: 'plan' },
  },
  workflow_config: {
    phase: 'researching',
    mode: 'standard',
    plannerTool: 'claude-code',
    plannerModel: 'opus',
    implementerTool: 'codex',
    implementerModel: 'gpt-5',
  },
  recovery_prompted: {
    phase: 'implementing',
    issueId: 'issue-1',
    reason: 'validation-failed',
    taskId: 'T001',
    files: ['src/a.ts'],
    affectedTaskIds: ['T001'],
    availableActions: ['retry-same-worker', 'skip-current-task'],
    recommendedAction: 'retry-same-worker',
    headline: 'Validation failed twice',
    resumeCommand: 'splitbrief resume',
  },
  recovery_action_selected: {
    phase: 'implementing',
    issueId: 'issue-1',
    reason: 'validation-failed',
    action: 'retry-same-worker',
  },
  recovery_action_failed: {
    phase: 'implementing',
    issueId: 'issue-1',
    reason: 'validation-failed',
    action: 'retry-same-worker',
    message: 'retry could not start',
  },
  recovery_resolved: {
    phase: 'implementing',
    issueId: 'issue-1',
    reason: 'validation-failed',
    action: 'retry-same-worker',
    outcome: 'continued',
  },
  planner_status: { phase: 'researching', status: 'running', tool: 'claude-code' },
  planner_text: { phase: 'researching', text: 'Reading the log format.' },
  planner_heartbeat: { phase: 'researching', elapsedMs: 500 },
  runner_call_started: { phase: 'implementing', ...callContext },
  runner_call_runtime_status: {
    phase: 'implementing',
    ...callContext,
    runtimeStatus: {
      phase: 'waiting-first-response',
      loadState: 'unknown',
      observedAt: TS,
    },
  },
  runner_call_text_delta: {
    phase: 'implementing',
    ...callContext,
    channel: 'assistant',
    text: 'partial',
  },
  runner_call_usage: {
    phase: 'implementing',
    ...callContext,
    usage: { inputTokens: 10, outputTokens: 4 },
    semantics: 'final',
  },
  runner_call_tool_use: {
    phase: 'implementing',
    ...callContext,
    stage: 'delta',
    toolUseId: 'tool-1',
    name: 'Read',
    inputDelta: '{"path":',
  },
  runner_call_activity: {
    phase: 'implementing',
    ...callContext,
    activityId: 'activity-1',
    stage: 'updated',
    kind: 'read',
    label: 'reading src/a.ts',
    target: 'src/a.ts',
    redacted: false,
  },
  runner_call_session_id: { phase: 'implementing', ...callContext, nativeSessionId: 'native-1' },
  runner_call_artifact: {
    phase: 'implementing',
    ...callContext,
    artifact: {
      id: 'artifact-1',
      source: 'stream',
      name: 'plan.md',
      path: null,
      mimeType: null,
      text: null,
    },
  },
  runner_call_warning: {
    phase: 'implementing',
    ...callContext,
    warning: { code: 'rate_limited', message: 'slow down' },
  },
  runner_call_error: {
    phase: 'implementing',
    ...callContext,
    status: 'failed',
    error: { code: 'exit_1', message: 'process failed' },
    partial: false,
    ...terminalFields,
  },
  runner_call_completed: {
    phase: 'implementing',
    ...callContext,
    status: 'completed',
    error: null,
    partial: false,
    ...terminalFields,
  },
  runner_call_stalled: { phase: 'implementing', ...callContext, silentMs: 60_000 },
  runner_call_stall_cleared: { phase: 'implementing', ...callContext },
  runner_call_heartbeat: { phase: 'implementing', ...callContext },
  artifact_written: {
    phase: 'specifying',
    filename: 'spec.md',
    path: '.splitbrief/spec.md',
    lineCount: 12,
    excerpt: ['# Spec'],
    omittedCount: 0,
    omittedUnit: 'line',
  },
  spec_approved: { phase: 'reviewing-spec' },
  spec_rejected: { phase: 'reviewing-spec' },
  spec_regenerated: { phase: 'specifying', comment: 'tighten the scope' },
  plan_approved: { phase: 'reviewing-plan' },
  plan_rejected: { phase: 'reviewing-plan' },
  plan_regenerated: { phase: 'planning', comment: 'split the second brief' },
  briefs_approved: { phase: 'reviewing-briefs' },
  briefs_rejected: { phase: 'reviewing-briefs' },
  rewind_to_spec: { phase: 'specifying', comment: 'start over' },
  rewind_to_plan: { phase: 'planning' },
  task_reset: { phase: 'implementing', taskId: 'T001' },
  all_tasks_done: { phase: 'implementing' },
  drift_report: { phase: 'implementing', passed: true, score: 1, errorCount: 0, warningCount: 0 },
  drift_chain_detected: {
    phase: 'implementing',
    chainLength: 3,
    score: 2,
    threshold: 1,
    uniqueOutOfBoundsFiles: ['src/b.ts'],
    representativePath: 'src/b.ts',
  },
  snapshot_created: { phase: 'implementing', snapshotId: 'snap-1', fileCount: 2 },
  snapshot_restored: {
    snapshotId: 'snap-1',
    restoredCount: 2,
    conflictedCount: 0,
    forcedCount: 0,
    forced: false,
  },
  snapshot_restore_conflict: { snapshotId: 'snap-1', conflictedPaths: ['src/b.ts'] },
  mode_resolved: { phase: 'researching', mode: 'standard', approve: 'plan' },
  mode_advice: {
    phase: 'researching',
    kind: 'none',
    risk: 'normal',
    currentMode: 'standard',
    suggestedMode: 'standard',
    confidence: 0.8,
    factors: ['one file'],
    missing: [],
  },
  instant_plan_received: { phase: 'planning', taskCount: 1 },
  tasks_planned: {
    phase: 'planning',
    tasks: [
      { id: 'T001', title: 'Invert the entry', index: 0, file: 'src/a.ts', action: 'create' },
    ],
    total: 1,
  },
  task_started: {
    phase: 'implementing',
    taskId: 'T001',
    title: 'Invert the entry',
    index: 0,
    total: 1,
    file: 'src/a.ts',
    action: 'modify',
  },
  task_completed: {
    phase: 'implementing',
    taskId: 'T001',
    title: 'Invert the entry',
    method: 'local',
    retries: 0,
    duration: 2_000,
  },
  task_skipped: {
    phase: 'implementing',
    taskId: 'T001',
    title: 'Invert the entry',
    reason: 'already done',
  },
  task_retry: { phase: 'implementing', taskId: 'T001', attempt: 1, maxRetries: 2, error: 'boom' },
  task_escalating: { phase: 'escalating', taskId: 'T001' },
  task_scope_widened: {
    phase: 'escalating',
    taskId: 'T001',
    paths: ['src/b.ts'],
    reason: 'b consumes the export',
  },
  task_touched_not_suggested: { phase: 'implementing', taskId: 'T001', files: ['src/b.ts'] },
  task_full_fail: { phase: 'implementing', taskId: 'T001', reason: 'retries exhausted' },
  review_fix_started: { phase: 'final-review', cycle: 1, taskIds: ['T001'] },
  task_tokens: {
    phase: 'implementing',
    taskId: 'T001',
    method: 'local',
    implementerTokens: 900,
    escalationTokens: 0,
    retryCount: 0,
  },
  task_review_needed: {
    phase: 'implementing',
    taskId: 'T001',
    taskTitle: 'Invert the entry',
    status: 'done',
    filesTouched: ['src/a.ts'],
    validation: { passed: true, summary: 'all gates green', stages: [] },
    evidence: { summary: 'diff reviewed', expected: [], observed: [] },
    cost: { tokenUsage },
    availableCommands: ['continue'],
  },
  hint_failed: { phase: 'escalating', taskId: 'T001' },
  consult_answered: {
    phase: 'escalating',
    taskId: 'T001',
    reason: 'failed',
    action: 'split-task',
    diagnosis: 'the task mixes two concerns',
    newTaskIds: ['T011', 'T012'],
  },
  task_replaced: { phase: 'escalating', taskId: 'T001', revision: 2 },
  tasks_inserted: { phase: 'escalating', parentId: 'T001', taskIds: ['T011', 'T012'] },
  checks_run: { phase: 'escalating', taskId: 'T001', results: [{ id: 'C1', passed: true }] },
  seat_wait_started: {
    phase: 'implementing',
    seat: 'build',
    resetAt: '2026-10-03T12:00:00.000Z',
  },
  seat_switched: {
    phase: 'implementing',
    seat: 'build',
    from: { tool: 'codex' },
    to: { tool: 'claude-code', model: 'opus' },
    cause: 'runner-usage-limit',
    auto: false,
    configRevision: 'r1',
  },
  seat_retry: { phase: 'implementing', seat: 'build', attempt: 1, delayMs: 1000 },
  no_progress_cut: {
    phase: 'implementing',
    taskId: 'T001',
    seat: 'build',
    silentMs: 1200000,
  },
  consult_bound_spent: { phase: 'escalating' },
  implementer_generate_running: { phase: 'implementing', taskId: 'T001' },
  implementer_generate_done: {
    phase: 'implementing',
    taskId: 'T001',
    file: 'src/a.ts',
    linesAdded: 30,
    linesRemoved: 2,
    duration: 4_000,
  },
  implementer_generate_failed: { phase: 'implementing', taskId: 'T001' },
  validate: {
    phase: 'validating-task',
    taskId: 'T001',
    status: 'done',
    passed: true,
    stages: { typecheck: true, lint: true, test: true },
  },

  review_started: {
    phase: 'implementing',
    scope: 'task',
    afterTaskId: 'T001',
    tool: 'codex',
    model: 'gpt-6.1-sol',
    axes: ['high'],
  },
  review_completed: {
    phase: 'implementing',
    scope: 'task',
    afterTaskId: 'T001',
    tool: 'codex',
    model: 'gpt-6.1-sol',
    axes: ['high'],
    verdict: 'pass',
    findings: { blocking: 0, minor: 1 },
    duration: 49_000,
  },
  review_checks: {
    phase: 'final-review',
    scope: 'final',
    status: 'planned',
    commands: [{ id: 'V1', command: 'npm test', reason: 'runs the changed tests' }],
    declined: [{ target: 'e2e/app.spec.ts', reason: 'needs a browser' }],
    reason: null,
  },
  full_suite: {
    phase: 'final-review',
    status: 'refused',
    id: 'V1',
    command: 'npm test',
    moment: 'pre-review',
    detail: 'runs the package script test, which this run changed',
  },
  escalate: { phase: 'escalating', taskId: 'T001', tier: 1 },
  git_commit: { phase: 'implementing', taskId: 'T001', message: 'feat: invert the entry' },
  git_checkpoint: { phase: 'implementing', taskId: 'T001', tag: 'splitbrief/T001' },
  git_branch_created: { phase: 'idle', name: 'splitbrief/replay' },
  clarifications_collected: {
    phase: 'clarifying',
    count: 1,
    clarifications: [{ question: 'which log?', answer: 'session.jsonl' }],
  },
  clarification_answered: { phase: 'clarifying', answer: 'session.jsonl' },
  message_queued: {
    phase: 'implementing',
    id: 'msg-1',
    preview: 'stop after this',
    origin: 'user-input',
  },
  message_injected_native: { phase: 'implementing', id: 'msg-1' },
  queue_drained: { phase: 'implementing', count: 1, ids: ['msg-1'] },
  steerable_call: { phase: 'implementing', seat: 'build', taskId: 'T001' },
  queue_cleared: { phase: 'implementing', count: 1 },
  user_message: { phase: 'implementing', text: 'keep going' },
  planner_attachments_dropped: {
    phase: 'researching',
    count: 1,
    reason: 'unsupported-backend',
  },
  build_images_as_paths: { phase: 'implementing', taskId: 'T001', count: 1 },
  cost_update: { phase: 'implementing', tokenUsage },
  approval_prompted: { phase: 'implementing', tier: 'confirm', actionClass: 'write_in_scope' },
  approval_granted: {
    phase: 'implementing',
    tier: 'confirm',
    actionClass: 'write_in_scope',
    scope: 'once',
  },
  approval_rejected: {
    phase: 'implementing',
    tier: 'confirm',
    actionClass: 'write_in_scope',
    reason: 'out of scope',
  },
  approval_sticky_recorded: {
    phase: 'implementing',
    pattern: 'src/**',
    scope: 'session',
    actionClass: 'write_in_scope',
  },
  approval_mode_changed: { mode: 'normal' },
  replay_started: { phase: 'idle', totalEvents: 2 },
  replay_complete: { phase: 'idle', totalEvents: 2, durationMs: 5 },
  warning: {
    phase: 'idle',
    category: 'jsonl',
    code: 'session_log_degraded',
    message: 'writes are failing',
  },
  error: { phase: 'idle', message: 'the run stopped' },
};

const EXTRA_SHAPES: Record<string, unknown>[] = [
  { type: 'steerable_call', phase: 'implementing' },
  {
    type: 'review_completed',
    phase: 'final-review',
    scope: 'final',
    tool: 'codex',
    verdict: 'stopped',
    duration: 1_000,
  },
  {
    type: 'runner_call_tool_use',
    phase: 'implementing',
    ...callContext,
    stage: 'done',
    toolUse: { id: 'tool-1', name: 'Read', input: { path: 'src/a.ts' } },
  },
  { type: 'error', phase: 'idle', category: 'recovery', code: 'review_failed', message: 'failed' },
];

function schemaEventTypes(): string[] {
  const schemaSource = readFileSync(join(import.meta.dirname, 'schema.ts'), 'utf8');
  const rewindSource = readFileSync(
    join(import.meta.dirname, '../../core/state/rewind-event.ts'),
    'utf8',
  );
  const builders = /(?:phase|noPhase|strictCallPhase|operationalMessage)Event\('([a-z_]+)'\)/g;
  const literals = /z\.literal\('([a-z_]+)'\)/g;
  const found = [
    ...[...schemaSource.matchAll(builders)].map((match) => match[1]),
    ...[...rewindSource.matchAll(literals)].map((match) => match[1]),
  ];
  return [...new Set(found.filter((type): type is string => type !== undefined))];
}

function sample(candidate: Record<string, unknown>): EngineEvent {
  const parsed = parseEngineEvent({ ts: TS, ...candidate });
  if (parsed === null) throw new Error(`sample does not parse: ${JSON.stringify(candidate)}`);
  return parsed;
}

function sampleFor(type: string, overrides: Record<string, unknown> = {}): EngineEvent {
  const fields = SAMPLES[type];
  if (fields === undefined) throw new Error(`no sample declared for ${type}`);
  return sample({ type, ...fields, ...overrides });
}

function writeLog(ref: SessionRef, events: EngineEvent[]): void {
  const append = createSessionLogAppender(ref);
  for (const event of events) append(toEngineEventEntry(event));
}

describe('readRunEvents', () => {
  let projectDir = '';
  const sessionId = 'replay-fixture';
  const ref = (): SessionRef => ({ projectDir, sessionId });

  beforeEach(() => {
    projectDir = createTempDir('splitbrief-replay');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it('covers every event variant the schema declares', () => {
    const types = schemaEventTypes();
    expect(types.length).toBeGreaterThan(40);
    expect(types.filter((type) => SAMPLES[type] === undefined)).toEqual([]);
  });

  it('pairs an adjacent compact attached-file message and event exactly once', async () => {
    ensureSessionDir(projectDir, sessionId);
    saveState(ref(), createInitialState('replay'));
    const message = attachedMessage(projectDir);
    const { bus, events } = makeBusRecorder();
    bus.subscribe(createJsonlSink(ref()));
    recordSteer({ ...ref(), bus }, 'planning', message);
    expect(message.text).toContain('PELICAN-42');
    await expectCompactMessage(ref(), events, message);
  });

  it('round-trips every event variant through session.jsonl', async () => {
    const corpus = [
      ...schemaEventTypes().map((type) => sampleFor(type)),
      ...EXTRA_SHAPES.map(sample),
    ];
    writeLog(ref(), corpus);

    const { events, diagnostics } = await readRunEvents(ref());

    expect(diagnostics).toEqual({ total: corpus.length, skipped: 0, unknownTypes: [] });
    expect(events.slice(1, -1)).toEqual(corpus);
  });

  it.each([undefined, 3])('replays review notes with outOfScope=%s', async (outOfScope) => {
    const findings = { blocking: 0, minor: 1, ...(outOfScope !== undefined && { outOfScope }) };
    const data = { ...SAMPLES.review_completed, verdict: 'pass-with-notes', findings };
    createSessionLogAppender(ref())({
      kind: 'event',
      ts: new Date(TS).toISOString(),
      type: 'review_completed',
      phase: 'implementing',
      data,
    });

    const { events, diagnostics } = await readRunEvents(ref());

    expect(diagnostics).toEqual({ total: 1, skipped: 0, unknownTypes: [] });
    expect(events[1]).toMatchObject({ type: 'review_completed', findings });
  });

  it('wraps the replayed events in replay_started and replay_complete', async () => {
    const first = sampleFor('workflow_started');
    const last = sampleFor('workflow_complete', { ts: TS + 5_000 });
    writeLog(ref(), [first, last]);

    const { events } = await readRunEvents(ref());

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ type: 'replay_started', ts: TS, totalEvents: 2 });
    expect(events[3]).toMatchObject({
      type: 'replay_complete',
      ts: TS + 5_000,
      totalEvents: 2,
      durationMs: 5_000,
      diagnostics: { totalLines: 2, replayedEvents: 2, skippedUnknown: 0 },
    });
  });

  it('spans the replayed events on the log clock, not the wall clock', async () => {
    writeLog(ref(), [
      sampleFor('workflow_started'),
      sampleFor('workflow_complete', { ts: TS + 90_000 }),
    ]);

    const first = await readRunEvents(ref());
    const second = await readRunEvents(ref());

    expect(first.events).toEqual(second.events);
    expect(first.events[first.events.length - 1]).toMatchObject({ durationMs: 90_000 });
  });

  it('reports an empty log as a replay of nothing', async () => {
    const { events, diagnostics } = await readRunEvents(ref());

    expect(events.map((event) => event.type)).toEqual(['replay_started', 'replay_complete']);
    expect(diagnostics).toEqual({ total: 0, skipped: 0, unknownTypes: [] });
  });

  it('restores message-only answers in order without merging repeated replies', async () => {
    const append = createSessionLogAppender(ref());
    const message = {
      kind: 'message',
      role: 'user',
      phase: 'researching',
      text: 'Keep the API.',
    } as const;
    append({ ...message, ts: String(TS) });
    append(toEngineEventEntry(sampleFor('planner_text', { ts: TS + 1 })));
    append({ ...message, ts: String(TS + 2) });

    const { events, diagnostics } = await readRunEvents(ref());

    expect(events.slice(1, -1).map((event) => event.type)).toEqual([
      'user_message',
      'planner_text',
      'user_message',
    ]);
    expect(
      events.filter((event) => event.type === 'user_message').map((event) => event.text),
    ).toEqual(['Keep the API.', 'Keep the API.']);
    expect(diagnostics).toEqual({ total: 1, skipped: 0, unknownTypes: [] });
    expect(events.at(-1)).toMatchObject({ diagnostics: { replayedEvents: 3, skippedNonEvent: 0 } });
  });

  it.each(['message-first', 'event-first'] as const)(
    'pairs %s records once without hiding a separate identical reply',
    async (order) => {
      const append = createSessionLogAppender(ref());
      const message = {
        kind: 'message',
        role: 'user',
        phase: 'researching',
        text: 'Continue.',
        ts: String(TS),
      } as const;
      const event = sampleFor('user_message', { phase: 'researching', text: message.text });
      if (order === 'message-first') append(message);
      append(toEngineEventEntry(event));
      if (order === 'event-first') append(message);
      append({ ...message, ts: String(TS + 1) });

      const { events, diagnostics } = await readRunEvents(ref());

      expect(events.filter((event) => event.type === 'user_message')).toHaveLength(2);
      expect(diagnostics.skipped).toBe(0);
    },
  );

  it('keeps a message when its neighboring user event is malformed', async () => {
    const append = createSessionLogAppender(ref());
    append({ kind: 'message', role: 'user', text: 'Continue.', ts: String(TS) });
    append({ kind: 'event', type: 'user_message', ts: 'invalid', data: { text: 'Continue.' } });

    const { events, diagnostics } = await readRunEvents(ref());

    expect(events[1]).toMatchObject({ type: 'user_message', text: 'Continue.', phase: 'idle' });
    expect(diagnostics.skipped).toBe(1);
  });

  it('skips retired variants, malformed data and unreadable lines, and counts each', async () => {
    const dir = sessionDir(projectDir, sessionId);
    mkdirSync(dir, { recursive: true });
    copyFileSync(LEGACY_FIXTURE, join(dir, SESSION_LOG_FILE));

    const { events, diagnostics } = await readRunEvents(ref());

    // The fixture holds two task_completed records, one sound and one with a retired method.
    // Only brief_compiled is unknown; a type that parsed somewhere is never named.
    expect(diagnostics).toEqual({
      total: 13,
      skipped: 2,
      unknownTypes: ['brief_compiled'],
    });
    expect(events).toHaveLength(13);
    expect(events[events.length - 1]).toMatchObject({
      type: 'replay_complete',
      diagnostics: {
        totalLines: 16,
        replayedEvents: 11,
        skippedBlank: 0,
        skippedNonEvent: 1,
        skippedMalformed: 2,
        skippedUnknown: 2,
        skippedOversized: 0,
      },
    });
  });

  it('reads the retired recovery vocabulary of an older run', async () => {
    const dir = sessionDir(projectDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const entries = [
      { type: 'paused_external_changes', phase: 'implementing', data: {} },
      {
        type: 'recovery_action_selected',
        phase: 'implementing',
        data: { issueId: 'issue-1', reason: 'retry-exhausted', action: 'pause-run' },
      },
      {
        type: 'recovery_prompted',
        phase: 'implementing',
        data: {
          issueId: 'issue-1',
          reason: 'context-overflow',
          files: [],
          affectedTaskIds: [],
          availableActions: ['route-bigger-worker', 'pause-run', 'end-run'],
          recommendedAction: 'pause-run',
          headline: 'T001 does not fit',
          resumeCommand: 'splitbrief resume',
        },
      },
    ];
    for (const entry of entries) {
      appendFileSync(
        join(dir, SESSION_LOG_FILE),
        `${JSON.stringify({ kind: 'event', ts: new Date(TS).toISOString(), ...entry })}\n`,
      );
    }

    const { events } = await readRunEvents(ref());

    // The external-changes pause and a selected pause are gone; the prompt keeps what its halt
    // still offers, and a recommendation it dropped becomes the first action left.
    expect(events.slice(1, -1)).toEqual([
      expect.objectContaining({
        type: 'recovery_prompted',
        availableActions: ['retry-same-worker', 'end-run'],
        recommendedAction: 'retry-same-worker',
      }),
    ]);
  });

  it('replays the payload_omitted warning the sink writes for an oversized event', async () => {
    const oversized = sample({
      type: 'artifact_written',
      phase: 'specifying',
      filename: 'spec.md',
      path: '.splitbrief/spec.md',
      lineCount: 20_000,
      excerpt: Array.from({ length: 20_000 }, (_, index) => `line ${index} ${'x'.repeat(40)}`),
      omittedCount: 0,
      omittedUnit: 'line',
    });
    const bounded = boundEngineEventForConsumer(oversized, 'session-log');
    expect(bounded).toMatchObject({ type: 'warning', code: 'payload_omitted' });
    writeLog(ref(), [bounded]);

    const { events, diagnostics } = await readRunEvents(ref());

    expect(diagnostics.skipped).toBe(0);
    expect(events[1]).toEqual(bounded);
  });

  it('skips a raw line that exceeds the session-log entry bound', async () => {
    const kept = sampleFor('workflow_started');
    writeLog(ref(), [kept]);
    const huge = toEngineEventEntry(
      sample({ type: 'user_message', phase: 'implementing', text: 'y' }),
    );
    const line = JSON.stringify({
      ...huge,
      data: { text: 'z'.repeat(SESSION_LOG_MAX_ENTRY_BYTES) },
    });
    appendFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), `${line}\n`);

    const { events, diagnostics } = await readRunEvents(ref());

    expect(diagnostics).toEqual({ total: 1, skipped: 0, unknownTypes: [] });
    expect(events[events.length - 1]).toMatchObject({
      type: 'replay_complete',
      diagnostics: { skippedOversized: 1 },
    });
  });

  it('reads the epoch-millisecond timestamps older logs wrote', async () => {
    const dir = sessionDir(projectDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const replayed = sample({ type: 'plan_approved', phase: 'reviewing-plan' });
    const entry = { ...toEngineEventEntry(replayed), ts: TS };
    appendFileSync(join(dir, SESSION_LOG_FILE), `${JSON.stringify(entry)}\n`);

    const { events, diagnostics } = await readRunEvents(ref());

    expect(diagnostics.skipped).toBe(0);
    expect(events[1]).toEqual({ type: 'plan_approved', ts: TS, phase: 'reviewing-plan' });
  });
});
