import { describe, expect, it } from 'vitest';
import { createRunnerCallId } from '../../../src/engine/calls/id.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../../src/engine/calls/types.js';
import { spawnAndCollect } from '../../../src/engine/streaming/spawn-collect/collect.js';

const callContext = (): RunnerCallContext => ({
  callId: createRunnerCallId('call'),
  role: 'implementer',
  backendKind: 'cli',
});

function forceGc(): void {
  globalThis.gc?.();
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function textDeltaBytes(events: readonly RunnerCallEvent[], channel: 'stderr' | 'stdout'): number {
  let bytes = 0;
  for (const event of events) {
    if (
      ((channel === 'stderr' && event.type === 'call_stderr_delta') ||
        (channel === 'stdout' && event.type === 'call_text_delta')) &&
      event.channel === channel
    ) {
      bytes += Buffer.byteLength(event.text, 'utf8');
    }
  }
  return bytes;
}

describe.skipIf(process.env.SPLITBRIEF_PERF !== '1')('runner large output perf', () => {
  it('returns a large stdout line without newline whole through spawn collection', async () => {
    const events: RunnerCallEvent[] = [];
    const script = [
      'const chunk = "stdout-no-newline-sentinel-" + "x".repeat(64 * 1024);',
      'for (let i = 0; i < 64; i += 1) process.stdout.write(chunk);',
    ].join('\n');

    forceGc();
    const startedAt = performance.now();
    const result = await spawnAndCollect({
      callContext: callContext(),
      command: 'node',
      args: ['-e', script],
      cwd: process.cwd(),
      onCallEvent: (event) => events.push(event),
    });
    const elapsedMs = performance.now() - startedAt;
    forceGc();

    const lineBytes = 64 * ('stdout-no-newline-sentinel-'.length + 64 * 1024);
    expect(result).toMatchObject({ status: 'completed', error: null });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'runner_call_text_limit', surface: 'debug' }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'call_completed' });
    expect(result.text.trimEnd().length).toBe(lineBytes);
    expect(textDeltaBytes(events, 'stdout')).toBeLessThanOrEqual(1024 * 1024);
    expect(serializedBytes(events)).toBeLessThan(1_250_000);
    expect(elapsedMs).toBeLessThan(4_000);
  });

  it('turns multi-megabyte stderr overflow into bounded warnings', async () => {
    const events: RunnerCallEvent[] = [];
    const lineCount = 160;
    const script = [
      'const line = "stderr-flood-sentinel-" + "x".repeat(16 * 1024) + "\\n";',
      `for (let i = 0; i < ${lineCount}; i += 1) process.stderr.write(line);`,
    ].join('\n');

    forceGc();
    const startedAt = performance.now();
    const result = await spawnAndCollect({
      callContext: callContext(),
      command: 'node',
      args: ['-e', script],
      cwd: process.cwd(),
      onCallEvent: (event) => events.push(event),
    });
    const elapsedMs = performance.now() - startedAt;
    forceGc();
    const serializedEvents = JSON.stringify(events);

    expect(result).toMatchObject({ status: 'completed', error: null });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'stderr_line_overflow' }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'call_completed' });
    expect(result.text).toBe('');
    expect(result.warnings.length).toBeLessThanOrEqual(lineCount + 1);
    expect(textDeltaBytes(events, 'stderr')).toBe(0);
    expect(serializedBytes(events)).toBeLessThan(512_000);
    expect(serializedEvents).not.toContain('stderr-flood-sentinel');
    expect(elapsedMs).toBeLessThan(4_000);
  });
});
