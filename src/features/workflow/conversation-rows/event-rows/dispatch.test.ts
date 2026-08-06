import { describe, expect, it } from 'vitest';
import { formatModelName } from '../../../../core/model-display.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../../stores/workflow/streaming-output.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import {
  makeRunnerCallCompleted,
  makeRunnerCallError,
  makeRunnerCallStarted,
} from '#testing/helpers/events/runner-call.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from '../../display/activity-label-display.js';
import { eventRowBlock } from './dispatch.js';
import { rowText } from '../row-format/rows.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

const suppressedRunnerCallTypes = [
  'runner_call_started',
  'runner_call_text_delta',
  'runner_call_usage',
  'runner_call_tool_use',
  'runner_call_session_id',
  'runner_call_artifact',
  'runner_call_warning',
  'runner_call_error',
  'runner_call_completed',
] as const;

function suppressedRunnerCallEvent(type: (typeof suppressedRunnerCallTypes)[number]): EngineEvent {
  const base = {
    ts: 0,
    phase: 'implementing' as const,
    callId: 'call-1',
    role: 'implementer' as const,
    backendKind: 'cli' as const,
    sequence: 1,
  };

  switch (type) {
    case 'runner_call_started':
      return makeRunnerCallStarted();
    case 'runner_call_text_delta':
      return { type, ...base, channel: 'assistant', text: 'hidden transcript' };
    case 'runner_call_usage':
      return {
        type,
        ...base,
        usage: { inputTokens: 1, outputTokens: 2 },
        semantics: 'delta',
      };
    case 'runner_call_tool_use':
      return {
        type,
        ...base,
        runnerName: 'codex',
        stage: 'delta',
        name: 'Bash',
        inputDelta: '{"command":"npm run typecheck"}',
      };
    case 'runner_call_session_id':
      return { type, ...base, nativeSessionId: 'native-session-1' };
    case 'runner_call_artifact':
      return {
        type,
        ...base,
        artifact: {
          id: 'artifact-1',
          source: 'tool',
          name: 'result.txt',
          path: '/tmp/result.txt',
          mimeType: 'text/plain',
          text: 'artifact body',
        },
      };
    case 'runner_call_warning':
      return {
        type,
        ...base,
        warning: {
          code: 'provider_warning',
          severity: 'warning',
          source: 'provider',
          surface: 'activity',
          fingerprint: 'rw-safe:1',
          message: 'provider warning',
        },
      };
    case 'runner_call_error':
      return makeRunnerCallError();
    case 'runner_call_completed':
      return makeRunnerCallCompleted();
  }
}

function activityLabelSegment(label: Parameters<typeof displayActivityLabel>[0]): string {
  return `${displayActivityLabel(label).padEnd(ACTIVITY_LABEL_PAD)}  `;
}

function activityLine(label: Parameters<typeof displayActivityLabel>[0], value: string): string {
  return `${activityLabelSegment(label)}${value}`;
}

describe('event row dispatch', () => {
  it('strips OSC-52/CSI control bytes from a user prompt row now that it owns the title', () => {
    const payload = 'ZWNobyBwd25lZA==';
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const malicious = `before${esc}]52;c;${payload}${bel}${esc}[2Jafter`;
    const event: EngineEvent = {
      type: 'user_message',
      ts: 0,
      phase: 'idle',
      text: malicious,
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(text).not.toContain(payload);
    expect(text).not.toContain(']52');
    expect(text).not.toContain('[2J');
    expect(text).toContain('beforeafter');
  });

  it.each([
    'researching',
    'specifying',
    'escalating',
  ] as const)('does not promise resume for %s cancellation events', (phase) => {
    const event: EngineEvent = {
      type: 'workflow_cancelled',
      ts: 0,
      phase,
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('Workflow cancelled');
    expect(text).not.toContain('Resume');
    expect(text).not.toContain('splitbrief continue');
  });

  it('renders task_full_fail as a visible failed terminal row', () => {
    const event: EngineEventOf<'task_full_fail'> = {
      type: 'task_full_fail',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual(['task failed  T001']);
    expect(rows[0]?.kind).toBe('summary');
    expect(rows[0]?.segments).toContainEqual({ text: 'task failed  ', tone: 'error' });
    expect(rows[0]?.segments).toContainEqual({ text: 'T001', tone: 'textDim' });
  });

  it.each([
    ['continued', 'success'],
    ['retry-current-task', 'success'],
    ['skipped-current-task', 'textDim'],
    ['aborted', 'error'],
  ] as const)('tones recovery_resolved outcome %s as %s', (outcome, tone) => {
    const event: EngineEventOf<'recovery_resolved'> = {
      type: 'recovery_resolved',
      ts: 0,
      phase: 'implementing',
      issueId: 'issue-1',
      reason: 'validation-failed',
      action: 'retry-same-worker',
      outcome,
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    const topRow = rows.find((rowValue) => rowValue.kind === 'card-top');
    expect(topRow).toBeDefined();
    expect(topRow?.segments[0]?.tone).toBe(tone);
    if (topRow !== undefined) {
      expect(rowText(topRow)).not.toContain('┌');
    }
    expect(rows.map(rowText).join('\n')).toContain(`${outcome} via retry-same-worker`);
  });

  it('redacts secrets in planner, warning, and user display rows', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const events: EngineEvent[] = [
      {
        type: 'planner_text',
        ts: 0,
        phase: 'planning',
        role: 'planner',
        text: `planner token ${secret} ${jwt}\u001b[31m`,
      },
      {
        type: 'warning',
        ts: 0,
        phase: 'implementing',
        message: 'aws AKIAIOSFODNN7EXAMPLE',
      },
      {
        type: 'user_message',
        ts: 0,
        phase: 'implementing',
        text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      },
    ];

    const text = events
      .flatMap((event, globalIndex) =>
        eventRows({
          event,
          globalIndex,
          expanded: false,
          ctx: { width: 80, viewportRows: 20, streaming },
        }),
      )
      .map(rowText)
      .join('\n');

    expect(text).toContain('***REDACTED***');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('eyJhbGci');
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('\u001b');
  });

  it('renders sanitized queued message text when queued and injected events carry it', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const events: EngineEvent[] = [
      {
        type: 'message_queued',
        ts: 0,
        phase: 'implementing',
        id: 'queued-1',
        preview: `ship it ${secret}\u001b[31m`,
      },
      {
        type: 'message_injected_native',
        ts: 1,
        phase: 'implementing',
        id: 'queued-1',
        preview: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      },
    ];

    const text = events
      .flatMap((event, globalIndex) =>
        eventRows({
          event,
          globalIndex,
          expanded: false,
          ctx: { width: 120, viewportRows: 20, streaming },
        }),
      )
      .map(rowText)
      .join('\n');

    expect(text).toContain('Queued  applies at the next planner prompt');
    expect(text).toContain('ship it sk-***REDACTED***');
    expect(text).toContain(
      'Message delivered to live session: Authorization: Bearer ***REDACTED***',
    );
    expect(text).not.toContain(secret);
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('\u001b');
  });

  it.each(suppressedRunnerCallTypes)('does not render %s as ordinary conversation rows', (type) => {
    const rows = eventRows({
      event: suppressedRunnerCallEvent(type),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows).toEqual([]);
  });

  it('renders safe runner activity as styled conversation rows', () => {
    const event: EngineEventOf<'runner_call_activity'> = {
      type: 'runner_call_activity',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'codex',
      sequence: 2,
      activityId: 'call-1:tool:Bash',
      stage: 'updated',
      kind: 'command',
      label: 'running npm run typecheck',
      target: 'npm run typecheck',
      redacted: false,
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      'Implementer activity  1 update  [OpenAI Codex CLI]',
      activityLine('RUN', 'npm run typecheck'),
    ]);
    expect(rows[0]?.kind).toBe('activity');
    expect(rows[1]?.segments).toEqual([
      { text: activityLabelSegment('RUN'), tone: 'accent' },
      { text: 'npm run typecheck', tone: 'textDim' },
    ]);
    expect(rows[1]?.kind).toBe('activity-child-last');
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 80)).toBe(true);
  });

  it('renders shell-wrapper activity without exposing the wrapper as the message label', () => {
    const event: EngineEventOf<'runner_call_activity'> = {
      type: 'runner_call_activity',
      ts: 0,
      phase: 'researching',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'codex',
      sequence: 2,
      activityId: 'call-1:system',
      stage: 'updated',
      kind: 'unknown',
      label: '/bin/zsh -lc "sed -n \'1,260p\' CLAUDE.md"',
      redacted: false,
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toBe(
      [
        'Plan activity  1 update  [OpenAI Codex CLI]',
        activityLine('READ', 'CLAUDE.md :1-260'),
      ].join('\n'),
    );
    expect(text).not.toContain('/bin/zsh -lc');
    expect(text).not.toContain('activity:');
  });

  it('redacts secrets in rendered runner activity rows', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const event: EngineEventOf<'runner_call_activity'> = {
      type: 'runner_call_activity',
      ts: 0,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'codex',
      sequence: 2,
      activityId: 'call-1:tool:Bash',
      stage: 'updated',
      kind: 'command',
      label: `running npm test ${secret}`,
      target: `npm test ${secret}`,
      redacted: false,
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('sk-***REDACTED***');
    expect(text).not.toContain(secret);
  });

  it('renders task routing reasons instead of generic cost posture noise', () => {
    const event: EngineEventOf<'task_started'> = {
      type: 'task_started',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Route narrow task',
      index: 0,
      total: 1,
      file: 'src/app.ts',
      action: 'modify',
      tool: 'codex',
      implementerProfile: 'cheap-cloud',
      contextFit: 'tight',
      estimatedTokens: 95_000,
      contextLength: 100_000,
      costPosture: 'Selected unknown cost tier via cheapest-capable routing',
      routingReason: 'current code reduced to fit cheap-cloud context',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 52, viewportRows: 20, streaming },
    });
    const lines = rows.map(rowText);
    const text = lines.join('\n');

    expect(text.replace(/\s+/g, ' ')).toContain(
      'why current code reduced to fit cheap-cloud context',
    );
    expect(text).not.toContain('cost Selected unknown cost tier');
    expect(lines.every((line) => line.length <= 52)).toBe(true);
  });

  it('keeps ordinary fit task-start routing rows compact', () => {
    const event: EngineEventOf<'task_started'> = {
      type: 'task_started',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Route ordinary task',
      index: 0,
      total: 1,
      file: 'src/app.ts',
      action: 'modify',
      implementerProfile: 'cheap-cloud',
      contextFit: 'fits',
      estimatedTokens: 3911,
      contextLength: 32_768,
      routingReason: 'selected cheapest capable profile',
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 52, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    const normalized = text.replace(/\s+/g, ' ');

    expect(normalized).toContain('fit fits');
    expect(normalized).toContain('why selected cheapest capable profile');
    expect(normalized).not.toContain('3911/32768 tok');
  });

  it.each([
    {
      name: 'error',
      event: {
        type: 'error',
        ts: 0,
        phase: 'implementing',
        message: 'disk write boundary exceeded',
      },
      stateWord: 'error',
      body: 'disk write boundary exceeded',
    },
    {
      name: 'budget_exceeded',
      event: {
        type: 'budget_exceeded',
        ts: 0,
        phase: 'implementing',
        currentCost: 12,
        maxBudget: 10,
      },
      stateWord: 'budget',
      body: 'Exceeded',
    },
    {
      name: 'recovery_action_failed',
      event: {
        type: 'recovery_action_failed',
        ts: 0,
        phase: 'implementing',
        issueId: 'issue-1',
        reason: 'validation-failed',
        action: 'retry-same-worker',
        message: 'worker unavailable',
      },
      stateWord: 'recovery',
      body: 'worker unavailable',
    },
    {
      name: 'brief_quality_failed',
      event: {
        type: 'brief_quality_failed',
        ts: 0,
        phase: 'planning',
        score: 0.5,
        errorCount: 2,
        warningCount: 1,
      },
      stateWord: 'brief quality',
      body: 'failed',
    },
    {
      name: 'task_full_fail',
      event: {
        type: 'task_full_fail',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
      },
      stateWord: 'task failed',
      body: 'T001',
    },
    {
      name: 'implementer_generate_failed',
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        model: 'qwen2.5-coder:7b',
      },
      stateWord: 'failed',
      body: formatModelName('qwen2.5-coder:7b'),
    },
  ] satisfies {
    name: string;
    event: EngineEvent;
    stateWord: string;
    body: string;
  }[])('keeps only the state word error-toned and dims the cause for $name', ({
    event,
    stateWord,
    body,
  }) => {
    const segments = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    }).flatMap((rowValue) => rowValue.segments);

    const errorSegments = segments.filter((segment) => segment.tone === 'error');
    const dimSegments = segments.filter((segment) => segment.tone === 'textDim');

    expect(errorSegments.some((segment) => segment.text.includes(stateWord))).toBe(true);
    expect(errorSegments.every((segment) => !segment.text.includes(body))).toBe(true);
    expect(dimSegments.some((segment) => segment.text.includes(body))).toBe(true);
  });

  it('renders an implementer failure without inventing an absent model', () => {
    const segments = eventRows({
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    }).flatMap((rowValue) => rowValue.segments);

    expect(segments.some((segment) => segment.tone === 'error' && segment.text === 'failed')).toBe(
      true,
    );
    expect(segments.some((segment) => segment.tone === 'textDim')).toBe(false);
  });

  it('renders the user prompt with a prompt marker row and message continuations', () => {
    const block = eventRowBlock({
      event: {
        type: 'user_message',
        ts: 1,
        phase: 'idle',
        text: 'add dark mode toggle to the settings screen',
      },
      globalIndex: 0,
      ctx: { width: 24, viewportRows: 20, streaming },
      expanded: false,
    });
    const rows = block?.createRows(0, block.rowCount) ?? [];

    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.kind).toBe('prompt');
    for (const row of rows.slice(1)) expect(row.kind).toBe('message');
  });

  it('renders user_message rows without the heavy-angle prompt marker', () => {
    const text = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'implementing',
        text: 'ship the redesign',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('ship the redesign');
    expect(text).not.toContain('❯');
  });

  it('turn_interrupted renders a warning callout row', () => {
    const event: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 0,
      phase: 'implementing',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText).join('\n')).toContain(
      'Turn stopped — type instructions to steer, or press Enter to retry.',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((rowValue) => rowValue.markerTone === 'warning')).toBe(true);
  });

  it('message_queued renders a Queued header above the message text', () => {
    const event: EngineEventOf<'message_queued'> = {
      type: 'message_queued',
      ts: 0,
      phase: 'implementing',
      id: 'queued-1',
      preview: 'ship it',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    const joined = rows.map(rowText).join('\n');
    expect(joined).toContain('Queued  applies at the next planner prompt');
    expect(joined.match(/queued/gi)).toHaveLength(1);
    expect(rows[0]?.markerTone).toBe('info');
    expect(rows[0]?.segments[0]?.tone).toBe('info');
    expect(rows[0]?.segments[1]?.tone).toBe('textDim');
    expect(rows[1] && rowText(rows[1])).toBe('ship it');
    expect(rows[1]?.segments[0]?.tone).toBe('text');
  });

  it('renders a visible blocked row when the readiness gate blocks', () => {
    const event: EngineEventOf<'brief_readiness_blocked'> = {
      type: 'brief_readiness_blocked',
      ts: 0,
      phase: 'planning',
      taskCount: 20,
      blockedCount: 3,
      blockedTaskIds: ['T001', 'T002', 'T003'],
      kinds: ['missing-worker'],
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(rowText).join('\n')).toContain('brief readiness');
    expect(rows.map(rowText).join('\n')).toContain('blocked · 3 tasks of 20');
    expect(rows.map(rowText).join('\n')).not.toContain('passed');
  });

  it('renders a passed row when the readiness gate clears', () => {
    const event: EngineEventOf<'brief_readiness_passed'> = {
      type: 'brief_readiness_passed',
      ts: 0,
      phase: 'planning',
      taskCount: 5,
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(rowText).join('\n')).toContain('passed · 5 tasks');
  });

  it('renders the pre-existing-failure line when the baseline done event carries failing stages', () => {
    const event: EngineEventOf<'validation_baseline'> = {
      type: 'validation_baseline',
      ts: 0,
      phase: 'implementing',
      status: 'done',
      stages: { typecheck: false, lint: false, test: true },
      failing: { typecheck: true },
      commands: { typecheck: 'npx tsc --noEmit' },
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    const text = rows.map(rowText).join('\n').replace(/\s+/g, ' ');
    expect(text).toContain('baseline');
    expect(text).toContain('typecheck (npx tsc --noEmit) failed');
    expect(text).toContain('already failing before any task ran: typecheck');
    expect(text).toContain('pre-existing failures will not fail this run');
    expect(
      rows.some((rowValue) =>
        rowValue.segments.some(
          (segment) => segment.tone === 'warning' && segment.text.includes('already failing'),
        ),
      ),
    ).toBe(true);
  });
});
