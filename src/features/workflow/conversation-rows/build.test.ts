import { describe, expect, it } from 'vitest';
import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { activityBatchKey } from './activity-batch-key.js';
import { buildConversationRows } from './build.js';
import { rowText } from './row-format.js';

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
    expect(text).toContain('planner activity  3 updates  [Codex]');
    expect(text.match(/sed -n/g)).toHaveLength(1);
    expect(text).toContain("run  sed -n '1,240p' CLAUDE.md");
    expect(text).toContain('run  wc -l CLAUDE.md');
    expect(text).toContain('run  rg -n \\');
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
    expect(text).toContain('planner activity  2 updates  [Codex]');
    expect(text.match(/npm run typecheck/g)).toHaveLength(1);
    expect(text).toContain('read  src/app.ts');
    expect(text).not.toContain('more  ctrl+a');
  });

  it('keeps the latest three distinct activity rows with an earlier-update affordance', () => {
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
    expect(text).not.toContain('a.ts');
    expect(text).toContain('more  ctrl+a expand 1 earlier update');
    expect(text).toContain('read  b.ts');
    expect(text).toContain('read  c.ts');
    expect(text).toContain('read  d.ts');

    const expanded = buildConversationRows({
      sections,
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set([activityBatchKey(0, 'call-1')]),
      cols: 88,
      viewportHeight: 20,
      streaming,
    });
    const expandedText = expanded.rows.map(rowText).join('\n');

    expect(expandedText).toContain('less  ctrl+a collapse 1 earlier update');
    expect(expandedText).toContain('read  a.ts');
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

    expect(text).toContain('interrupted  current turn interrupted');
    expect(text).not.toContain('error');
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

    expect(text).toContain('warning  stderr: npm deprecated package token sk-***REDACTED***');
    expect(text).toContain('error  exit_code_1: Command failed: npm test');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});
