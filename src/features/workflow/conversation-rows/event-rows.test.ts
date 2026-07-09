import { describe, expect, it } from 'vitest';
import { formatModelName } from '../../../core/model-display.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from '../display/activity-label-display.js';
import { eventRowBlock } from './event-rows.js';
import { rowText } from './row-format.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function activityLabelSegment(label: Parameters<typeof displayActivityLabel>[0]): string {
  return `${displayActivityLabel(label).padEnd(ACTIVITY_LABEL_PAD)}  `;
}

function activityLine(label: Parameters<typeof displayActivityLabel>[0], value: string): string {
  return `${activityLabelSegment(label)}${value}`;
}

describe('eventRows', () => {
  it('renders markdown planner documents without raw heading or fence markers', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'planning',
      content: 'markdown',
      text: [
        'id: T001',
        'title: Run no-op validation smoke check',
        '---',
        '',
        '### Description',
        'Run a quick validation-only smoke check.',
        '',
        '### Signature',
        '```typescript',
        '// No exported signature.',
        '```',
      ].join('\n'),
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');
    const heading = rows.find((rowValue) => rowText(rowValue).includes('Description'));

    expect(rowText(rows[0] ?? { key: 'missing', kind: 'message', segments: [] })).toBe('Plan');
    expect(rows[0]?.segments).toContainEqual({ text: 'Plan', tone: 'planner', bold: true });
    expect(rowText(rows[1] ?? { key: 'missing', kind: 'message', segments: [] })).toBe('id: T001');
    expect(rows[1]?.segments).toContainEqual({ text: 'T001', tone: 'text', bold: true });
    expect(text).toContain('Description');
    expect(text).toContain('// No exported signature.');
    expect(text).not.toContain('│');
    expect(text).not.toContain('###');
    expect(text).not.toContain('```typescript');
    expect(text).not.toContain('```');
    expect(heading?.segments).toContainEqual({
      text: 'Description',
      tone: 'markdownHeading',
      bold: true,
    });
  });

  it('strips a leading H1 heading from the planner’s first transcript block when it echoes the title', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'analyzing',
      content: 'markdown',
      text: '# Add dark-mode toggle\n\nLooking into the request now.',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      dedupTitle: 'Add dark-mode toggle',
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(text).not.toContain('Add dark-mode toggle');
    expect(text).toContain('Looking into the request now.');
  });

  it('keeps a leading H1 heading that does not echo the title', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'analyzing',
      content: 'markdown',
      text: '# Add dark-mode toggle\n\nLooking into the request now.',
    };

    const rows = eventRows({
      event,
      globalIndex: 1,
      expanded: false,
      dedupTitle: 'A completely different feature',
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('Add dark-mode toggle');
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
    expect(text).not.toContain('diptych continue');
  });

  it('renders skipped task ids without adding a second task prefix', () => {
    const event: EngineEventOf<'task_skipped'> = {
      type: 'task_skipped',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Validate no-op workflow',
      reason: 'dependency failed',
    };

    const text = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    })
      .map(rowText)
      .join('\n');

    expect(text).toContain('T001 Validate no-op workflow: dependency failed');
    expect(text).not.toContain('TT001');
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

  it('strips terminal controls before wrapping planner rows', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'planning',
      role: 'planner',
      text: `abcd\u001b]52;c;${'x'.repeat(80)}\u0007efgh`,
    };

    const lines = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 4, viewportRows: 20, streaming },
    }).map(rowText);

    expect(lines).toEqual(['ab', 'cd', 'ef', 'gh']);
    expect(lines.every((line) => getTerminalCellWidth(line) <= 2)).toBe(true);
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

    expect(text).toContain('Message queued during implementing: ship it sk-***REDACTED***');
    expect(text).toContain(
      'Message delivered to live session: Authorization: Bearer ***REDACTED***',
    );
    expect(text).not.toContain(secret);
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('\u001b');
  });

  it('does not render runner tool use as ordinary conversation rows', () => {
    const event: EngineEventOf<'runner_call_tool_use'> = {
      type: 'runner_call_tool_use',
      ts: 0,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'codex',
      sequence: 1,
      stage: 'delta',
      name: 'Bash',
      inputDelta: '{"command":"npm run typecheck sk-abcdefghijklmnopqrstuvwxyz"}',
    };

    const rows = eventRows({
      event,
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
      'Implementer activity  1 update  [Codex]',
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
      ['Plan activity  1 update  [Codex]', activityLine('READ', 'CLAUDE.md :1-260')].join('\n'),
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

  it('renders workflow activity rows as bounded compact rows', () => {
    const events: EngineEvent[] = [
      {
        type: 'planner_text',
        ts: 0,
        phase: 'planning',
        role: 'planner',
        text: 'Planning plain text',
      },
      {
        type: 'task_started',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        title: 'Validate no-op workflow',
        index: 0,
        total: 1,
        file: 'README.md',
        action: 'modify',
        tool: 'codex',
        implementerProfile: 'default',
      },
      {
        type: 'implementer_generate_running',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        file: 'README.md',
      },
      {
        type: 'implementer_generate_done',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        file: 'README.md',
        diff: '+ added line\n- removed line',
        linesAdded: 1,
        linesRemoved: 1,
        duration: 1234,
      },
      {
        type: 'validate',
        ts: 0,
        phase: 'validating-task',
        taskId: taskId('T001'),
        status: 'done',
        passed: false,
        stages: { typecheck: false, lint: false, test: false },
        error: 'typecheck failed',
      },
      {
        type: 'escalate',
        ts: 0,
        phase: 'escalating',
        taskId: taskId('T001'),
        tier: 1,
        hint: 'retry with narrower scope',
      },
    ];

    for (const event of events) {
      const rows = eventRows({
        event,
        globalIndex: 0,
        expanded: true,
        ctx: {
          width: 80,
          viewportRows: 20,
          streaming: {
            taskId: taskId('T001'),
            lines: ['streamed output'],
            active: true,
          },
        },
      });

      expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 80)).toBe(true);
      expect(rows.every((rowValue) => rowValue.kind.length > 0)).toBe(true);
    }
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
});
