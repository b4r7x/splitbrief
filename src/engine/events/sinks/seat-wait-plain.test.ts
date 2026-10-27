import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { EngineEvent, EngineEventOf } from '../types.js';
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
const resetAt = '2026-10-27T12:00:00.000Z';

describe('seat wait plain output', () => {
  it('writes one line that starts with waiting: OpenAI Codex CLI · resets when a wait starts', () => {
    const start: EngineEventOf<'seat_wait_started'> = {
      type: 'seat_wait_started',
      ts,
      phase: 'idle',
      seat: 'build',
      resetAt,
      tool: 'OpenAI Codex CLI',
    };
    const lines = collect([start]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('waiting: OpenAI Codex CLI · resets')).toBe(true);
  });

  it('adds no line when a seat wait ends', () => {
    const start: EngineEventOf<'seat_wait_started'> = {
      type: 'seat_wait_started',
      ts,
      phase: 'idle',
      seat: 'build',
      resetAt,
      tool: 'OpenAI Codex CLI',
    };
    const end: EngineEventOf<'seat_wait_ended'> = {
      type: 'seat_wait_ended',
      ts,
      phase: 'idle',
      seat: 'build',
    };
    const lines = collect([start]);
    const linesWithEnd = collect([start, end]);
    expect(linesWithEnd).toEqual(lines);
  });

  it('writes no waiting line when a start event has no tool', () => {
    const startNoTool: EngineEventOf<'seat_wait_started'> = {
      type: 'seat_wait_started',
      ts,
      phase: 'idle',
      seat: 'build',
      resetAt,
    };
    expect(collect([startNoTool])).toEqual([]);
  });

  it('writes no waiting line when reset time does not parse', () => {
    const startUnparseable: EngineEventOf<'seat_wait_started'> = {
      type: 'seat_wait_started',
      ts,
      phase: 'idle',
      seat: 'build',
      resetAt: 'invalid-date',
      tool: 'OpenAI Codex CLI',
    };
    expect(collect([startUnparseable])).toEqual([]);
  });

  it('writes no waiting line when tool is empty', () => {
    const startEmptyTool: EngineEventOf<'seat_wait_started'> = {
      type: 'seat_wait_started',
      ts,
      phase: 'idle',
      seat: 'build',
      resetAt,
      tool: '',
    };
    expect(collect([startEmptyTool])).toEqual([]);
  });
});
