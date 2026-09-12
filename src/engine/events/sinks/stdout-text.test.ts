import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../types.js';
import { createStdoutTextSink } from './stdout-text.js';

function collect(events: EngineEvent[]): string[] {
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const sink = createStdoutTextSink({ output });
  for (const event of events) sink(event);
  return chunks.join('').trimEnd().split('\n').filter(Boolean);
}

const ts = 1;

describe('createStdoutTextSink', () => {
  it('writes one line per phase change, task, review and completion', () => {
    const lines = collect([
      { type: 'workflow_started', ts, phase: 'researching', feature: 'add a widget' },
      { type: 'planner_heartbeat', ts, phase: 'researching', elapsedMs: 5, accumulatedTokens: 1 },
      {
        type: 'validate',
        ts,
        phase: 'implementing',
        taskId: taskId('T001'),
        status: 'done',
        passed: true,
        stages: { typecheck: true, lint: true, test: false },
      },
      {
        type: 'task_completed',
        ts,
        phase: 'implementing',
        taskId: taskId('T001'),
        title: 'Add the widget',
        method: 'local',
        retries: 0,
        duration: 12,
      },
      {
        type: 'cost_update',
        ts,
        phase: 'implementing',
        tokenUsage: {
          plannerInput: 1000,
          plannerOutput: 500,
          implementerInput: 400,
          implementerOutput: 100,
          escalationInput: 0,
          escalationOutput: 0,
          reviewerInput: 0,
          reviewerOutput: 0,
        },
      },
      { type: 'workflow_complete', ts, phase: 'complete' },
    ]);

    expect(lines).toEqual([
      'phase: researching',
      'phase: implementing',
      'task T001: done (typecheck lint)',
      'phase: complete',
      'review: passed',
      'done: 1 tasks, 2.0k tokens',
    ]);
  });

  it('reports a failed final review and a failed task', () => {
    const lines = collect([
      { type: 'task_full_fail', ts, phase: 'implementing', taskId: taskId('T002') },
      {
        type: 'planner_status',
        ts,
        phase: 'final-review',
        status: 'done',
        summary: 'Final review failed',
      },
    ]);

    expect(lines).toEqual([
      'phase: implementing',
      'task T002: failed (no gates)',
      'phase: final-review',
      'review: failed',
    ]);
  });

  it('writes nothing for pre-start events that carry the idle phase', () => {
    const lines = collect([
      { type: 'warning', ts, phase: 'idle', message: 'Session JSONL sink is degraded.' },
      { type: 'error', ts, phase: 'idle', message: 'Planner claude-code is not available.' },
      { type: 'workflow_started', ts, phase: 'researching', feature: 'add a widget' },
    ]);

    expect(lines).toEqual(['phase: researching']);
  });
});
