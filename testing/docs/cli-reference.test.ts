import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createStdoutTextSink } from '../../src/engine/events/sinks/stdout-text.js';
import type { EngineEvent } from '../../src/engine/events/types.js';

const projectRoot = join(import.meta.dirname, '../..');
const cliReferencePath = join(projectRoot, 'docs/CLI-REFERENCE.md');
const cliReference = readFileSync(cliReferencePath, 'utf8');

const PLAIN_HEADING = '### Plain output stream';

function sinkLines(events: readonly EngineEvent[]): string[] {
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const sink = createStdoutTextSink({ output });
  for (const event of events) sink(event);
  return chunks.join('').trimEnd().split('\n').filter(Boolean);
}

function firstFencedBlockAfter(marker: string): string[] {
  const heading = cliReference.indexOf(marker);
  expect(heading, `missing heading ${marker}`).toBeGreaterThanOrEqual(0);
  const open = cliReference.indexOf('```', heading);
  expect(open, `missing fenced block after ${marker}`).toBeGreaterThan(heading);
  const close = cliReference.indexOf('```', open + 3);
  expect(close, `unclosed fenced block after ${marker}`).toBeGreaterThan(open);
  return cliReference
    .slice(open + 3, close)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

describe('CLI reference plain output example', () => {
  it('ends in the lines the sink writes last, in the order it writes them', () => {
    const lines = sinkLines([
      {
        type: 'review_completed',
        ts: 1,
        phase: 'final-review',
        scope: 'final',
        tool: 'codex',
        verdict: 'pass',
        findings: { blocking: 0, minor: 0 },
        duration: 12,
      },
      { type: 'workflow_complete', ts: 1, phase: 'complete', completedTasks: 3 },
    ]);
    const closing = lines.slice(-3);
    expect(closing).toEqual(['review: passed', 'phase: complete', 'done: 3 tasks']);

    const block = firstFencedBlockAfter(PLAIN_HEADING);
    const start = block.indexOf(closing[0] ?? '');
    expect(start, 'the example does not show the review line').toBeGreaterThanOrEqual(0);
    expect(block.slice(start, start + closing.length)).toEqual(closing);
  });

  it('lists the waiting line in the shape the sink writes', () => {
    const shape = /^- `(waiting: [^`]*)`/m.exec(cliReference)?.[1];
    expect(shape, 'the reference does not list the waiting line').toBe(
      'waiting: <tool> · resets <clock>',
    );
    const line = sinkLines([
      {
        type: 'seat_wait_started',
        ts: 1,
        phase: 'implementing',
        seat: 'build',
        resetAt: '2026-10-27T17:00:00.000Z',
        tool: 'OpenAI Codex CLI',
      },
    ]).at(-1);
    expect(
      line?.replace('OpenAI Codex CLI', '<tool>').replace(/resets .+$/, 'resets <clock>'),
    ).toBe(shape);
  });
});
