import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { eventRows } from './event-rows.js';
import { rowText } from './row-format.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function expectNoConversationGutter(rows: ReturnType<typeof eventRows>): void {
  const textRows = rows.map(rowText);

  expect(textRows.join('\n')).not.toMatch(/[│┆]/);
  expect(textRows.every((text) => !/^\s/.test(text))).toBe(true);
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

    expect(rowText(rows[0] ?? { key: 'missing', segments: [] })).toBe('id: T001');
    expect(rows[0]?.segments).toContainEqual({ text: 'T001', tone: 'accent', bold: true });
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

  it('renders workflow activity rows without persistent left gutters or leading layout spaces', () => {
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
      expectNoConversationGutter(
        eventRows({
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
        }),
      );
    }
  });
});
