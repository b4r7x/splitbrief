import { describe, expect, it } from 'vitest';
import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { makeImplementerGenerate } from '#testing/helpers/events.js';
import { activityBatchKey } from './activity-batch-key.js';
import {
  buildConversationRowActions,
  buildConversationRows,
  materializeConversationRowsWindow,
} from './build.js';
import { rowText } from './row-format.js';
import type { ConversationRowBlock } from './types.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function activity(
  overrides: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: overrides.ts ?? 0,
    phase: overrides.phase ?? 'researching',
    callId: overrides.callId ?? 'call-1',
    role: overrides.role ?? 'planner',
    backendKind: overrides.backendKind ?? 'cli',
    runnerName: overrides.runnerName ?? 'codex',
    sequence: overrides.sequence ?? 1,
    activityId: overrides.activityId ?? 'activity-1',
    stage: overrides.stage ?? 'updated',
    kind: overrides.kind ?? 'unknown',
    label: overrides.label ?? 'checking project',
    redacted: overrides.redacted ?? false,
    ...(overrides.target !== undefined && { target: overrides.target }),
    ...(overrides.model !== undefined && { model: overrides.model }),
    ...(overrides.taskId !== undefined && { taskId: overrides.taskId }),
    ...(overrides.attempt !== undefined && { attempt: overrides.attempt }),
    ...(overrides.textPartial !== undefined && { textPartial: overrides.textPartial }),
    ...(overrides.diagnosticPartial !== undefined && {
      diagnosticPartial: overrides.diagnosticPartial,
    }),
  };
}

describe('buildConversationRows', () => {
  it('materializes only blocks that intersect the requested row window', () => {
    const calls: string[] = [];
    const block = (key: string, rowCount: number): ConversationRowBlock => ({
      key,
      rowCount,
      renderableUnits: 1,
      createRows: (windowStart, windowEnd) => {
        calls.push(`${key}:${windowStart}-${windowEnd}`);
        return Array.from({ length: windowEnd - windowStart }, (_, index) => ({
          key: `${key}-${windowStart + index}`,
          kind: 'message',
          segments: [{ text: `${key}-${windowStart + index}` }],
        }));
      },
    });

    const rows = materializeConversationRowsWindow({
      projection: {
        blocks: [block('before', 2), block('visible', 3), block('after', 2)],
        renderableCount: 3,
        totalRows: 7,
      },
      windowStart: 2,
      windowEnd: 4,
    });

    expect(calls).toEqual(['visible:0-2']);
    expect(rows.map(rowText)).toEqual(['visible-0', 'visible-1']);
  });

  it('batches repeated runner activity from one call into one renderable block', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'call-1:tool:sed-start',
            kind: 'command',
            label:
              'running "sed -n \'1,240p\' CLAUDE.md" /bin/zsh -lc "sed -n \'1,240p\' CLAUDE.md"',
            target: '"sed -n \'1,240p\' CLAUDE.md" /bin/zsh -lc "sed -n \'1,240p\' CLAUDE.md"',
          }),
          activity({
            sequence: 2,
            activityId: 'call-1:tool:sed-done',
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
    expect(text).toContain('plan activity  3 updates  [Codex]');
    expect(text.match(/sed -n/g)).toHaveLength(1);
    expect(text).toContain("RUN   sed -n '1,240p' CLAUDE.md");
    expect(text).toContain('RUN   wc -l CLAUDE.md');
    expect(text).toContain('PLAN  rg -n \\');
    expect(text).not.toContain('/bin/zsh -lc');
    expect(text).not.toContain('activity:');
  });

  it('counts duplicate raw activity events by normalized visible activity', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          activity({
            sequence: 1,
            activityId: 'run-start',
            kind: 'command',
            label: 'running /bin/zsh -lc "npm run typecheck"',
            target: '/bin/zsh -lc "npm run typecheck"',
          }),
          activity({
            sequence: 2,
            activityId: 'run-done',
            kind: 'command',
            label: '/bin/zsh -lc "npm run typecheck"',
          }),
          activity({
            sequence: 3,
            activityId: 'run-repeat',
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
    expect(text).toContain('plan activity  2 updates  [Codex]');
    expect(text.match(/npm run typecheck/g)).toHaveLength(1);
    expect(text).toContain('READ  src/app.ts');
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
    expect(text).toContain('plan activity  4 updates  [Codex]');
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

  it('pins the highest-severity warning or error in collapsed activity blocks', () => {
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

    expect(text).toContain('plan activity  5 updates  1 warn  [Codex]');
    expect(text).toContain('WARN  stderr');
    expect(text).toContain('READ  c.ts');
    expect(text).toContain('READ  d.ts');
    expect(text).not.toContain('READ  a.ts');
    expect(text).not.toContain('READ  b.ts');
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
    expect(text).toContain('model sk-***REDACTED***');
    expect(text).not.toContain('eyJhbGci');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('renders user interruption as warning copy without internal runner codes', () => {
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

    expect(text).toContain('WARN  current turn interrupted');
    expect(text).not.toContain('runner_interrupted');
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

    expect(text).toContain('WARN  stderr: npm deprecated package token sk-***REDACTED***');
    expect(text).toContain('ERR   exit_code_1: Command failed: npm test');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
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
});

describe('buildConversationRowActions', () => {
  it('maps the rendered +N more row to a toggle-activity-batch action', () => {
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
    const inputs = {
      sections,
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    };

    const { rows } = buildConversationRows(inputs);
    const moreRow = rows.find((row) => row.kind === 'activity-more');
    if (!moreRow) throw new Error('expected a +N more disclosure row');

    const actions = buildConversationRowActions(inputs);
    expect(actions.get(moreRow.key)).toEqual({
      type: 'toggle-activity-batch',
      key: activityBatchKey(0, 'call-1'),
    });
  });

  it('maps the rendered diff rows to a toggle-diff action keyed by global render index', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [makeImplementerGenerate({ status: 'done', file: 'a.ts', diff: '+ x', ts: 5 })],
      },
    ];
    const inputs = {
      sections,
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    };

    const { rows } = buildConversationRows(inputs);
    const actions = buildConversationRowActions(inputs);
    const actionableRows = rows.filter((row) => actions.has(row.key));

    expect(actionableRows.length).toBeGreaterThan(0);
    for (const row of actionableRows) {
      expect(actions.get(row.key)).toEqual({
        type: 'toggle-diff',
        key: 'implementer_generate_done:0',
      });
    }
  });

  it('does not map a non-expandable activity batch', () => {
    const sections: Section<EngineEvent>[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [activity({ sequence: 1, activityId: 'a', kind: 'read', label: 'reading a.ts' })],
      },
    ];
    const actions = buildConversationRowActions({
      sections,
      expandedDiffs: new Set<string>(),
      expandedActivityBatches: new Set<string>(),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });

    expect(actions.size).toBe(0);
  });
});
