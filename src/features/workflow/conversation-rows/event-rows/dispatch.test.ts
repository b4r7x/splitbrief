import { describe, expect, it } from 'vitest';
import { CREW_SEAT_LABELS, formatSeatCandidateIdentity } from '../../../../core/crew/identity.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../../stores/workflow/streaming-output.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { glyph } from '../../../../lib/glyphs.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import {
  makeRunnerCallCompleted,
  makeRunnerCallError,
  makeRunnerCallStarted,
} from '#testing/helpers/events/runner-call.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from '../../display/activity-label-display.js';
import { configStore } from '../../../../stores/project/config.js';
import { eventRowBlock } from './dispatch.js';
import { rowText } from '../row-format/rows.js';
import { rowLeadingCells } from '../row-markers.js';
import type { ConversationRow } from '../types.js';

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
          fingerprint: 'rw:1',
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

function requireRow(
  rows: ConversationRow[],
  matcher: (row: ConversationRow) => boolean,
): ConversationRow {
  const found = rows.find(matcher);
  if (found === undefined) throw new Error('requireRow: no row matched');
  return found;
}

// Array subscripts are `ConversationRow | undefined` under noUncheckedIndexedAccess, so every row
// lookup in this file goes through one of these two rather than through `rows[i] ?? rows[0]`, which
// type-checks nowhere and hides a missing row behind a neighbour when it does.
function textAt(rows: ConversationRow[], index: number): string {
  const found = rows.at(index);
  if (found === undefined) throw new Error(`textAt: no row at index ${index}`);
  return rowText(found);
}

describe('event row dispatch', () => {
  it('names the files a brief changed beyond its suggested files on one dim row', () => {
    const rows = eventRows({
      event: {
        type: 'task_touched_not_suggested',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T003'),
        files: ['src/x.ts', 'src/y.ts'],
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual(['T003 also changed src/x.ts, src/y.ts']);
    expect(rows[0]?.segments.every((segment) => segment.tone === 'textDim')).toBe(true);
  });

  it('states the drift findings without a score, even for an old event that carried one', () => {
    const text = (event: EngineEvent): string =>
      eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming },
      })
        .map(rowText)
        .join('\n');
    const base = { type: 'drift_report', ts: 0, phase: 'final-review', passed: true } as const;

    expect(text({ ...base, errorCount: 0, warningCount: 0 })).toContain('clean');
    const old = text({ ...base, score: 0.6, errorCount: 1, warningCount: 1 } as EngineEvent);
    expect(old).toContain('1 error · 1 warning');
    expect(old).not.toContain('score');
  });

  it('reads a retired approval toggle without a transcript row', () => {
    const rows = eventRows({
      event: { type: 'approval_mode_changed', ts: 0, mode: 'yolo' },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows).toEqual([]);
  });

  it('states the lineage attempt and allowance on a retry after a grant', () => {
    const rows = eventRows({
      event: {
        type: 'task_retry',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        attempt: 1,
        maxRetries: 3,
        error: 'failed',
        lineageAttempt: 7,
        attemptAllowance: 12,
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    expect(rows.map(rowText).join('\n')).toContain('attempt 7 of 12');
  });

  it.each([
    ['balance', 'Balance spent on OpenCode CLI'],
    ['billing', 'Billing refused by OpenCode CLI'],
    ['quota', 'Quota spent on OpenCode CLI'],
  ] as const)('uses the recorded balance headline in the switch row', (accountCause, headline) => {
    const rows = eventRows({
      event: {
        type: 'seat_switched',
        ts: 0,
        phase: 'implementing',
        seat: 'build',
        from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
        cause: 'runner-usage-limit',
        accountCause,
        headline,
        auto: true,
        configRevision: 'revision',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 200, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain(headline);
    expect(text).not.toContain('usage limit');
  });

  it('renders a legacy seat switch without inventing a balance cause', () => {
    const to = { tool: 'claude-code', model: 'claude-sonnet-4' } as const;
    const rows = eventRows({
      event: {
        type: 'seat_switched',
        ts: 0,
        phase: 'implementing',
        seat: 'build',
        from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        to,
        cause: 'runner-usage-limit',
        auto: true,
        configRevision: 'abc123',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      `${CREW_SEAT_LABELS.build} ${glyph('connectorHandoff')} ${formatSeatCandidateIdentity(to)} · usage limit`,
    ]);
    expect(rows[0]?.segments.every((segment) => segment.tone === 'textDim')).toBe(true);
    expect(rows.map(rowText).join('\n')).not.toContain('Balance spent');
  });

  it('names a signed-out seat switch in the words the halt uses', () => {
    const rows = eventRows({
      event: {
        type: 'seat_switched',
        ts: 0,
        phase: 'implementing',
        seat: 'plan',
        from: { tool: 'codex' },
        to: { tool: 'claude-code' },
        cause: 'runner-unauthenticated',
        auto: true,
        configRevision: 'abc123',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });

    const text = rows.map(rowText).join('\n');
    expect(text).toContain(CREW_SEAT_LABELS.plan);
    expect(text).toContain('signed out');
  });

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

  describe('the attached files of a request', () => {
    const request: EngineEventOf<'user_message'> = {
      type: 'user_message',
      ts: 0,
      phase: 'idle',
      text: 'build it',
      attachedInputs: [
        { path: '/Users/dev/notes.md', kind: 'text' },
        { path: '/Volumes/design/mock.png', kind: 'image' },
      ],
    };

    function requestLines(event: EngineEvent, width: number): string[] {
      return eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width, viewportRows: 40, streaming },
      })
        .map(rowText)
        .map((line) => line.trim());
    }

    it.each([120, 80, 60])('names every attached file by its full path at %i columns', (width) => {
      const lines = requestLines(request, width);
      const header = lines.indexOf('Attached files · 2');

      expect(lines.findIndex((line) => line.includes('build it'))).toBeLessThan(header);
      expect(lines.slice(header, header + 3)).toEqual([
        'Attached files · 2',
        '/Users/dev/notes.md · text',
        '/Volumes/design/mock.png · image',
      ]);
    });

    it('wraps a long path without shortening it', () => {
      const long =
        '/Users/dev/projects/a-rather-long-folder-name/another-nested-level/brief-for-the-feature.md';
      const lines = requestLines(
        { ...request, attachedInputs: [{ path: long, kind: 'text' }] },
        40,
      );

      expect(lines.join('')).toContain(long);
      expect(lines.join('\n')).not.toContain('…');
    });

    it('strips terminal control bytes from an attached path', () => {
      const esc = String.fromCharCode(0x1b);
      const bel = String.fromCharCode(0x07);
      const text = requestLines(
        {
          ...request,
          attachedInputs: [{ path: `/tmp/${esc}]0;pwned${bel}brief.md`, kind: 'text' }],
        },
        80,
      ).join('\n');

      expect(text).toContain('/tmp/brief.md · text');
      expect(text).not.toContain('pwned');
    });

    it('shows a file inside the project relative to it and any other file in full', () => {
      configStore.__testReset({ projectDir: '/repo' });
      try {
        const lines = requestLines(
          {
            ...request,
            attachedInputs: [
              { path: '/repo/docs/brief.md', kind: 'text' },
              { path: '/elsewhere/mock.png', kind: 'image' },
            ],
          },
          80,
        );

        expect(lines).toContain('docs/brief.md · text');
        expect(lines).toContain('/elsewhere/mock.png · image');
      } finally {
        configStore.__testReset();
      }
    });

    it('keeps a path with line breaks on its own entry', () => {
      const lines = requestLines(
        {
          ...request,
          attachedInputs: [{ path: '/tmp/a\nreview: passed\n\tbrief.md', kind: 'text' }],
        },
        80,
      );
      const header = lines.indexOf('Attached files · 1');

      expect(lines.slice(header + 1)).toHaveLength(1);
      expect(lines.some((line) => line.startsWith('review: passed'))).toBe(false);
    });

    it('adds no attached-files rows to a request without attached inputs', () => {
      const { attachedInputs: _omitted, ...plain } = request;

      expect(requestLines(plain, 80).join('\n')).not.toContain('Attached files');
    });
  });

  it.each(['researching', 'specifying', 'escalating'] as const)(
    'does not promise resume for %s cancellation events',
    (phase) => {
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

      expect(text).toContain('Build failed');
      expect(text).not.toContain('Resume');
      expect(text).not.toContain('splitbrief continue');
    },
  );

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

    expect(rows.map(rowText)).toEqual(['Task failed  T001']);
    expect(rows[0]?.kind).toBe('summary');
    expect(rows[0]?.segments).toContainEqual({ text: 'Task failed  ', tone: 'error' });
    expect(rows[0]?.segments).toContainEqual({ text: 'T001', tone: 'textDim' });
  });

  it('renders a planner command the stage did not take as one dim validation row', () => {
    const rows = eventRows({
      event: {
        type: 'warning',
        ts: 0,
        phase: 'planning',
        message: 'The lint stage does not take npm run lint from the planner.',
        category: 'validation',
        code: 'discovered_validation_refused',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      'Validation  The lint stage does not take npm run lint from the planner.',
    ]);
    expect(rows.flatMap((row) => row.segments).every((segment) => segment.tone !== 'warning')).toBe(
      true,
    );
    expect(rows[0]?.markerTone).toBeUndefined();
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
      `${CREW_SEAT_LABELS.build} activity  1 update  [OpenAI Codex CLI · auto]`,
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
        `${CREW_SEAT_LABELS.plan} activity  1 update  [OpenAI Codex CLI · auto]`,
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

  it('renders a tight fit on a task-start row as its estimate against the window', () => {
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

    const normalized = text.replace(/\s+/g, ' ');
    // MAIN112 F4 wraps task-header metadata label-atomically: a label that moves to a
    // continuation drops the ` · ` it broke on. Assert the facts, not the old wrap point.
    expect(normalized).not.toContain('worker cheap-cloud');
    expect(normalized).toContain('~95,000 of 100K context tokens (tight)');
    expect(lines.every((line) => !line.trimEnd().endsWith('·'))).toBe(true);
    expect(normalized).not.toContain('current code reduced');
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

    const lines = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 52, viewportRows: 20, streaming },
    }).map(rowText);
    const text = lines.join('\n');

    const normalized = text.replace(/\s+/g, ' ');

    expect(normalized).toContain('src/app.ts (modify)');
    expect(normalized).not.toContain('worker cheap-cloud');
    expect(lines.every((line) => !line.trimEnd().endsWith('·'))).toBe(true);
    expect(normalized).not.toContain('fit');
    expect(normalized).not.toContain('selected cheapest capable profile');
    expect(normalized).not.toContain('3,911');
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
      stateWord: 'Error',
      body: 'disk write boundary exceeded',
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
      stateWord: 'Recovery',
      body: 'worker unavailable',
    },
    {
      name: 'task_full_fail',
      event: {
        type: 'task_full_fail',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
      },
      stateWord: 'Task failed',
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
        error: 'Tool implementer (opencode) exited without changing any files',
      },
      stateWord: `${CREW_SEAT_LABELS.build} failed`,
      body: 'Tool implementer (opencode) exited without changing any files',
    },
  ] satisfies {
    name: string;
    event: EngineEvent;
    stateWord: string;
    body: string;
  }[])(
    'keeps only the state word error-toned and dims the cause for $name',
    ({ event, stateWord, body }) => {
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
    },
  );

  it('renders an implementer failure without inventing an absent cause', () => {
    const rows = eventRows({
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        model: 'qwen2.5-coder:7b',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([`${CREW_SEAT_LABELS.build} failed`]);
    expect(rows.flatMap((rowValue) => rowValue.segments).some((s) => s.tone === 'textDim')).toBe(
      false,
    );
  });

  function implementerFailedRows(error: string, width: number): ConversationRow[] {
    return eventRows({
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T010'),
        model: 'opencode-go/deepseek-v4.1-flash',
        error,
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width, viewportRows: 20, streaming },
    });
  }

  function renderedCells(rowValue: ConversationRow): number {
    return (
      rowLeadingCells(rowValue.kind) +
      getTerminalCellWidth(rowValue.segments.map((segment) => segment.text).join(''))
    );
  }

  it.each([60, 80, 120])(
    'names the cause of an implementer failure on one row at width %i',
    (width) => {
      const cause =
        'Tool implementer (opencode) exited without changing any files after a completed call that reported done for every file in its brief';
      const rows = implementerFailedRows(
        `${cause}\nHint: check the tool's own log for the edits it reported`,
        width,
      );

      expect(rows).toHaveLength(1);
      const text = rowText(rows[0] as ConversationRow);
      expect(text.startsWith(`${CREW_SEAT_LABELS.build} failed  Tool implementer`)).toBe(true);
      expect(text.endsWith('…')).toBe(true);
      expect(text).not.toContain('Hint');
      expect(renderedCells(rows[0] as ConversationRow)).toBeLessThanOrEqual(width);
    },
  );

  it.each([60, 80, 120])(
    'keeps a wide, control-laden implementer cause on one row at width %i',
    (width) => {
      const rows = implementerFailedRows(`\u001b[31m${'界'.repeat(width)}\u001b[0m`, width);

      expect(rows).toHaveLength(1);
      expect(renderedCells(rows[0] as ConversationRow)).toBeLessThanOrEqual(width);
      expect(rowText(rows[0] as ConversationRow)).not.toContain('\u001b');
    },
  );

  it.each([60, 80, 120])('keeps a cut, redacted assignment on one row at width %i', (width) => {
    const rows = implementerFailedRows(`${'x'.repeat(width - 28)} password=x`, width);

    expect(rows).toHaveLength(1);
    expect(renderedCells(rows[0] as ConversationRow)).toBeLessThanOrEqual(width);
    expect(rowText(rows[0] as ConversationRow)).not.toContain('***REDACTED***');
  });

  it('expands a cut implementer failure to the whole cause, wrapped', () => {
    const cause =
      'Tool implementer (opencode) exited without changing any files after a completed call that reported done for every file in its brief';
    const rows = eventRows({
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T010'),
        model: 'opencode-go/deepseek-v4.1-flash',
        error: cause,
      },
      globalIndex: 0,
      expanded: true,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(rowText).join('\n').replace(/\s+/g, ' ')).toContain(cause);
    expect(rows.every((row) => renderedCells(row) <= 80)).toBe(true);
    expect(rows.map(rowText).join('\n')).not.toContain('…');
  });

  it('keeps a fitting implementer cause on one row even when expanded', () => {
    const rows = eventRows({
      event: {
        type: 'implementer_generate_failed',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T010'),
        model: 'opencode-go/deepseek-v4.1-flash',
        error: 'Edit bundle did not apply',
      },
      globalIndex: 0,
      expanded: true,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      `${CREW_SEAT_LABELS.build} failed  Edit bundle did not apply`,
    ]);
  });

  it('names the first non-blank line of an implementer cause', () => {
    for (const error of ['\nEdit bundle did not apply', '   \nEdit bundle did not apply']) {
      expect(implementerFailedRows(error, 80).map(rowText)).toEqual([
        `${CREW_SEAT_LABELS.build} failed  Edit bundle did not apply`,
      ]);
    }
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

  it('renders answered structured questions as voice-coded q/a pairs', () => {
    const block = eventRowBlock({
      event: {
        type: 'user_message',
        ts: 1,
        phase: 'clarifying',
        text: '1. What should be refactored? Give a file/module/feature name or area of the codebase.\nI want you to first review the changes and then after review make tasks of fixes for implementer\n\n2. What kind of refactor?\nSimplify/clean up existing code',
        qa: [
          {
            question:
              'What should be refactored? Give a file/module/feature name or area of the codebase.',
            answer:
              'I want you to first review the changes and then after review make tasks of fixes for implementer',
          },
          { question: 'What kind of refactor?', answer: 'Simplify/clean up existing code' },
        ],
      },
      globalIndex: 4,
      ctx: { width: 60, viewportRows: 40, streaming },
      expanded: false,
    });
    const rows = block?.createRows(0, block.rowCount) ?? [];
    const texts = rows.map(rowText);

    expect(texts).toEqual([
      'Answered · 2 questions',
      '1. What should be refactored? Give a file/module/feature ',
      '   name or area of the codebase.',
      'You → I want you to first review the changes and then ',
      'after review make tasks of fixes for implementer',
      '2. What kind of refactor?',
      'You → Simplify/clean up existing code',
    ]);
    expect(rows[0]?.kind).toBe('prompt');
    expect(rows[0]?.segments[0]?.tone).toBe('textDim');
    expect(rows[0]?.segments[0]?.bold).toBe(true);
    expect(rows[0]?.segments[1]?.tone).toBe('planner');
    expect(rows[0]?.segments[1]?.bold).toBe(true);
    expect(rows[1]?.segments[0]?.text).toBe('1.');
    expect(rows[1]?.segments[0]?.tone).toBe('planner');
    expect(rows[1]?.segments[0]?.bold).toBe(true);
    expect(rows[1]?.segments[1]?.tone).toBeUndefined();
    expect(rows[1]?.segments[2]?.tone).toBe('planner');
    expect(rows[1]?.segments[2]?.bold).not.toBe(true);
    expect(rows[2]?.segments[0]?.tone).toBe('planner');
    expect(rows.slice(1, 3).every((rowValue) => rowValue.segments[0]?.tone === 'planner')).toBe(
      true,
    );
    expect(rows.slice(3, 5).every((rowValue) => rowValue.segments[0]?.tone === 'text')).toBe(true);
    expect(rows.slice(3, 5).every((rowValue) => rowValue.segments[0]?.bold === false)).toBe(true);

    expect(rows.filter((rowValue) => rowValue.kind === 'prompt')).toHaveLength(1);
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 60)).toBe(true);
  });

  it('starts a wrapped continuation on the column of the line it continues', () => {
    // At 59 columns the `trim: false` wrapper wedges its break space onto the head of the
    // continuation line, one cell past the line above. The block trims it back so the question's
    // continuation keeps the gutter column and the answer's continuation keeps the content column.
    const rows = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'clarifying',
        text: 'x',
        qa: [
          {
            question:
              'What should be refactored? Give a file/module/feature name or area of the codebase.',
            answer:
              'I want you to first review the changes and then after review make tasks of fixes for implementer',
          },
          { question: 'What kind of refactor?', answer: 'Simplify/clean up existing code' },
        ],
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 59, viewportRows: 40, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      'Answered · 2 questions',
      '1. What should be refactored? Give a file/module/feature',
      '   name or area of the codebase.',
      'You → I want you to first review the changes and then',
      'after review make tasks of fixes for implementer',
      '2. What kind of refactor?',
      'You → Simplify/clean up existing code',
    ]);
  });

  it('labels a single answered question in the singular', () => {
    const rows = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'clarifying',
        text: '1. Which module?\nsrc/auth.ts',
        qa: [{ question: 'Which module?', answer: 'src/auth.ts' }],
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      'Answered · 1 question',
      '1. Which module?',
      'You → src/auth.ts',
    ]);
  });

  it('pulls a stranded wrap word down so no line ends the block as one lone word', () => {
    const rows = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'clarifying',
        text: '1. What should be refactored? Give a file/module/feature name or area of the codebase.\nReview',
        qa: [
          {
            question:
              'What should be refactored? Give a file/module/feature name or area of the codebase.',
            answer: 'Review',
          },
        ],
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText)).toEqual([
      'Answered · 1 question',
      '1. What should be refactored? Give a file/module/feature name or area of',
      '   the codebase.',
      'You → Review',
    ]);
  });

  it('aligns every number to the widest label so questions share one column, and starts every answer on the content column', () => {
    const rows = eventRows({
      event: {
        type: 'user_message',
        ts: 0,
        phase: 'clarifying',
        text: 'x',
        qa: Array.from({ length: 11 }, (_, index) => ({
          question: `Question ${index + 1}?`,
          answer: `Answer ${index + 1}`,
        })),
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 40, streaming },
    });

    // `11.` is the widest label, so every number pads to its width plus one space and every
    // question hangs at that shared column. Each answer carries no mark, so it starts on the
    // content column with no leading indent. The bold numbers alone separate the pairs — no blank
    // rows between them.
    const expected = [
      'Answered · 11 questions',
      ...Array.from({ length: 11 }, (_, index) =>
        index === 0
          ? ['1.  Question 1?', 'You → Answer 1']
          : [`${`${index + 1}.`.padEnd(4)}Question ${index + 1}?`, `You → Answer ${index + 1}`],
      ).flat(),
    ];
    expect(rows.map(rowText)).toEqual(expected);
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

    expect(rows.map((row) => rowText(row).trimEnd())).toEqual(['Stopped mid-turn']);
    expect(rows.every((rowValue) => rowValue.markerTone === 'warning')).toBe(true);
  });

  it('wraps fix-check rows between whole counts and verdict phrases', () => {
    for (const ownLeft of [0, 2]) {
      const event: EngineEventOf<'full_suite'> = {
        type: 'full_suite',
        ts: 0,
        phase: 'implementing',
        moment: 'brief',
        id: 'V2',
        command: 'npm run test-ci',
        status: 'done',
        passed: ownLeft === 0,
        duration: 180_000,
        own: 2,
        ownLeft,
        others: 3,
      };
      const rows = eventRows({
        event,
        globalIndex: 0,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming },
      }).map(rowText);
      const text = rows.join('\n');
      expect(text).toContain('2\u00a0failures');
      expect(rows.some((row) => row.includes('3m\u00a00s'))).toBe(true);
      if (ownLeft === 0) expect(rows.some((row) => row.includes('3\u00a0others'))).toBe(true);
      else expect(rows.some((row) => row.includes('2\u00a0of'))).toBe(true);
    }
    const event: EngineEventOf<'full_suite'> = {
      type: 'full_suite',
      ts: 0,
      phase: 'implementing',
      moment: 'brief',
      id: 'V2',
      command: 'npm run test-ci',
      status: 'done',
      passed: false,
      duration: 180_000,
      own: 2,
      ownLeft: 0,
      others: 3,
      proven: false,
    };
    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    }).map(rowText);
    expect(rows.some((row) => row.includes('not\u00a0proven\u00a0fixed'))).toBe(true);
  });

  it('turn_interrupted at a gate names the gate and never offers a retry', () => {
    const event: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 0,
      phase: 'reviewing-plan',
      source: 'user',
      at: 'boundary',
      step: { kind: 'gate', gate: 'plan' },
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('at the plan');
    expect(text).not.toContain('reopen');
    expect(text).not.toContain('Turn stopped');
    expect(text).not.toContain('retry');
  });

  it('turn_interrupted at a brief boundary names the brief it pauses before', () => {
    const event: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 0,
      phase: 'implementing',
      source: 'user',
      at: 'boundary',
      step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('before T002');
    expect(text).not.toContain('Turn stopped');
    expect(text).not.toContain('retry');
    expect(text).not.toContain('after T002');
  });

  it('turn_interrupted mid-brief names the brief and leaves the keys to the byline', () => {
    const event: EngineEventOf<'turn_interrupted'> = {
      type: 'turn_interrupted',
      ts: 0,
      phase: 'implementing',
      source: 'user',
      at: 'mid-step',
      step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text.trimEnd()).toBe('Stopped at T002');
  });

  it('task_retry counts attempts the way the build block does', () => {
    const event: EngineEventOf<'task_retry'> = {
      type: 'task_retry',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      attempt: 1,
      maxRetries: 2,
      error: 'tests failed',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    expect(rows.map(rowText).join('\n')).toContain('attempt 2 of 3');
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

  it('message_queued from a clarification renders an answered header instead of Queued', () => {
    const event: EngineEventOf<'message_queued'> = {
      type: 'message_queued',
      ts: 0,
      phase: 'specifying',
      id: 'queued-2',
      origin: 'clarification',
      preview: 'clarification: Use JWT? -> Yes, use JWT',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });

    const joined = rows.map(rowText).join('\n');
    expect(joined).toContain('Answered  recorded — applied at the next planner call');
    expect(joined).not.toMatch(/queued/i);
    expect(rows[0]?.markerTone).toBe('success');
    expect(rows[0]?.segments[0]?.tone).toBe('success');
    expect(rows[0]?.segments[1]?.tone).toBe('textDim');
    expect(rows[1] && rowText(rows[1])).toBe('clarification: Use JWT? -> Yes, use JWT');
    expect(rows[1]?.segments[0]?.tone).toBe('text');
  });
});

describe('validate failure output', () => {
  const columnar = [
    '  × Formatter would have printed the following content:',
    "    16 16 │       ['lm-studio', 'kimi-k2.7-code', { state: 'supported', source: 'provider' }],",
    "    17    │ - ····['lm-studio',·'text-embedding-3-large',·{·state:·'unsupported'·}],",
    '       17 │ + ····[',
  ].join('\n');

  function failedValidate(error: string): EngineEvent {
    return {
      type: 'validate',
      ts: 0,
      phase: 'validating-task',
      taskId: taskId('T002'),
      status: 'done',
      passed: false,
      stages: { typecheck: true, lint: false, test: false },
      attempted: { typecheck: true, lint: true, test: false },
      commands: { typecheck: 'npx tsc --noEmit', lint: 'npm run lint' },
      error,
    };
  }

  it('renders columnar tool output one row per source line, cut at the width', () => {
    const rows = eventRows({
      event: failedValidate(columnar),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });

    const bodyRows = rows.filter((rowValue) => rowValue.kind === 'callout-body');
    const sourceRows = bodyRows.slice(0, columnar.split('\n').length);
    expect(sourceRows.map(rowText).every((text) => text.length > 0)).toBe(true);
    expect(bodyRows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 76)).toBe(true);

    const gutterColumns = new Set(
      bodyRows.map((rowValue) => rowText(rowValue).indexOf('│')).filter((column) => column >= 0),
    );
    expect(gutterColumns.size).toBe(1);
  });

  // The summary row above dropped the commands so it would stop wrapping mid-stage. The header
  // names the failing stage and the footer names the command, once each: carrying the command in
  // both put one string on screen twice, cut at two different columns.
  it('names the failing stage at the head and the command to rerun at the foot', () => {
    const rows = eventRows({
      event: failedValidate(columnar),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });

    const header = requireRow(rows, (rowValue) => rowValue.kind === 'callout-top');
    expect(rowText(header)).toBe('Error  lint');
    expect(header.segments[0]?.tone).toBe('error');
    // The rail is structure: severity lives on the label and the signed rows, never on a
    // full-height column that reads as one field once sixteen colours flatten it.
    expect(
      rows
        .filter((rowValue) => rowValue.kind.startsWith('callout'))
        .every((rowValue) => rowValue.markerTone === 'border'),
    ).toBe(true);
    expect(textAt(rows, -1)).toBe(`${glyph('treeLast')} run npm run lint`);
    expect(rows.filter((rowValue) => rowText(rowValue).includes('npm run lint'))).toHaveLength(1);
  });

  it('keeps a single-line error on one row', () => {
    const rows = eventRows({
      event: failedValidate('typecheck failed'),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });
    const body = rows.filter((rowValue) => rowValue.kind === 'callout-body');

    expect(body.map(rowText)).toEqual([
      'typecheck failed',
      '',
      `${glyph('treeLast')} run npm run lint`,
    ]);
  });

  it('emits no error block while validation is still running', () => {
    const rows = eventRows({
      event: { ...failedValidate(columnar), status: 'running' } as EngineEvent,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });

    expect(rows.some((rowValue) => rowValue.kind === 'callout-body')).toBe(false);
  });

  const exemptValidate: EngineEvent = {
    type: 'validate',
    ts: 0,
    phase: 'validating-task',
    taskId: taskId('T002'),
    status: 'done',
    passed: true,
    exempt: true,
    stages: { typecheck: true, lint: false, test: false },
    attempted: { typecheck: true, lint: true, test: true },
    skipped: { test: true },
    skippedReason: { test: 'no affected test file found' },
    duration: 1_800,
  };

  it('keeps the stage notes off the one-line summary strip', () => {
    const rows = eventRows({
      event: exemptValidate,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 78, viewportRows: 20, streaming },
    });
    const texts = rows.map(rowText);

    expect(texts[0]).toContain('Validate');
    expect(texts[0]).not.toContain('skipped');
    expect(texts.slice(1)).toContain(
      'lint pre-existing failure, test skipped (no affected test file found)',
    );
  });

  // Appended to the strip, the reason a gate never ran was the first thing a narrow terminal cut.
  it('wraps the stage notes rather than cutting the reason at a narrow width', () => {
    const rows = eventRows({
      event: exemptValidate,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 44, viewportRows: 20, streaming },
    });
    const notes = rows.map(rowText).slice(1).join('').replace(/\s+/g, ' ').trim();

    expect(notes).toBe('lint pre-existing failure, test skipped (no affected test file found)');
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 44)).toBe(true);
  });

  it('names a run the user stopped apart from one that fell over', () => {
    const stopped = eventRows({
      event: { type: 'workflow_cancelled', ts: 0, phase: 'implementing', reason: 'user_cancelled' },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(stopped).toContain('Stopped by you');
    expect(stopped).not.toContain('Build failed');
  });
});

describe('consult answer rows', () => {
  const arrow = glyph('connectorHandoff');

  function rowsFor(event: EngineEventOf<'consult_answered'>): ConversationRow[] {
    return eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });
  }

  it('splits one row naming the new briefs and the diagnosis, never a panel', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'failed',
      action: 'split-task',
      diagnosis: 'Two independent changes share one brief.',
      newTaskIds: [taskId('T011'), taskId('T012')],
    });

    expect(rows.map(rowText)).toEqual([
      `PLAN ${arrow} T003: split into T011, T012 · Two independent changes share one brief.`,
    ]);
    expect(rows[0]?.kind).toBe('message');
    expect(rows.some((rowValue) => rowValue.kind === 'card-top')).toBe(false);
  });

  it('renders guidance with its diagnosis', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'blocked',
      action: 'guidance',
      diagnosis: 'The export is missing.',
      newTaskIds: null,
    });

    expect(rows.map(rowText)).toEqual([`PLAN ${arrow} T003: guidance · The export is missing.`]);
  });

  it('renders a rewritten brief with its new revision', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'failed',
      action: 'rewrite-task',
      diagnosis: 'The brief asked for the wrong module.',
      newTaskIds: null,
      revision: 2,
    });

    expect(rows.map(rowText)).toEqual([`PLAN ${arrow} T003: rewrote T003 (rev 2)`]);
  });

  it('renders a verification request with the checks it named', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'stale',
      action: 'verify',
      diagnosis: 'The failure may predate the rewrite.',
      newTaskIds: null,
      checkIds: ['C1', 'C2'],
    });

    expect(rows.map(rowText)).toEqual([`PLAN ${arrow} T003: verify C1, C2`]);
  });

  it('renders an ask-user answer as the one row pointing at the user', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T003'),
      reason: 'blocked',
      action: 'ask-user',
      diagnosis: 'Only you know which account to use.',
      newTaskIds: null,
    });

    expect(rows.map(rowText)).toEqual([`PLAN ${arrow} T003: asks you`]);
  });

  it('renders a decision-confirm as one row counting the confirmed decisions', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T004'),
      reason: 'deviation',
      action: 'confirm',
      diagnosis: 'Both are changes of how.',
      newTaskIds: null,
      decisionCount: 2,
    });

    expect(rows.map(rowText)).toEqual(['PLAN confirmed 2 decisions for T004']);
    expect(rows.some((rowValue) => rowValue.kind === 'card-top')).toBe(false);
  });

  it('renders a decision-confirm that asks the user as one row', () => {
    const rows = rowsFor({
      type: 'consult_answered',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T004'),
      reason: 'deviation',
      action: 'ask-user',
      diagnosis: 'Dropping the flag changes what is built.',
      newTaskIds: null,
    });

    expect(rows.map(rowText)).toEqual(['PLAN asks you about the decisions T004 reported']);
  });

  it('keeps the consult consequence events out of the transcript', () => {
    const events: EngineEvent[] = [
      {
        type: 'task_replaced',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T003'),
        revision: 2,
      },
      {
        type: 'tasks_inserted',
        ts: 0,
        phase: 'implementing',
        parentId: taskId('T003'),
        taskIds: [taskId('T011'), taskId('T012')],
      },
      {
        type: 'checks_run',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T003'),
        results: [{ id: 'C1', passed: true }],
      },
      {
        type: 'seat_wait_started',
        ts: 0,
        phase: 'implementing',
        seat: 'plan',
        resetAt: '2026-05-01T10:00:00.000Z',
      },
      {
        type: 'seat_retry',
        ts: 0,
        phase: 'implementing',
        seat: 'plan',
        attempt: 2,
        delayMs: 500,
      },
      {
        type: 'no_progress_cut',
        ts: 0,
        phase: 'implementing',
        taskId: null,
        seat: 'build',
        silentMs: 600_000,
      },
      { type: 'consult_bound_spent', ts: 0, phase: 'implementing' },
    ];

    for (const event of events) {
      expect(
        eventRows({
          event,
          globalIndex: 0,
          expanded: false,
          ctx: { width: 120, viewportRows: 20, streaming },
        }),
      ).toEqual([]);
    }
  });
});

describe('review_checks rows', () => {
  function reviewChecks(): EngineEventOf<'review_checks'> {
    return {
      type: 'review_checks',
      ts: 0,
      phase: 'final-review',
      scope: 'final',
      status: 'planned',
      commands: [{ id: 'V1', command: 'npm test', reason: 'The unit tests cover the change.' }],
      declined: [
        {
          target: 'npm run test:e2e',
          reason: 'It needs a browser, and the change touches no screen at all.',
        },
      ],
      reason: null,
    };
  }

  it('heads the declined tests, each indented under the headline and wrapped inside the width', () => {
    const rows = eventRows({
      event: reviewChecks(),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 60, viewportRows: 20, streaming },
    });
    const texts = rows.map(rowText).filter((text) => text.trim() !== '');

    expect(texts[0]?.trim()).toBe('Reviewer checks · chose 1 · declined 1');
    const headIndent = (texts[0] ?? '').search(/\S/);
    const declined = texts.slice(1);
    expect(declined.length).toBeGreaterThan(1);
    expect(declined[0]?.trim().startsWith('declined · npm run test:e2e ·')).toBe(true);
    for (const text of declined) {
      expect(text.search(/\S/)).toBe(headIndent + 2);
      expect(getTerminalCellWidth(text)).toBeLessThanOrEqual(60);
    }
  });

  it('paints one off row when End-of-run checks are off', () => {
    const rows = eventRows({
      event: { type: 'review_checks', ts: 0, phase: 'final-review', scope: 'final', status: 'off' },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const texts = rows.map(rowText).filter((text) => text.trim() !== '');

    expect(texts.map((text) => text.trim())).toEqual([
      'End-of-run checks · off · no reviewer check ran',
    ]);
  });
});
