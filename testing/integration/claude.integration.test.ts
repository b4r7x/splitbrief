import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { guardClaude } from './guard.js';

function collectStream(command: string, args: string[]): Promise<{ lines: string[]; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', (code) => {
      const lines = stdout.split('\n').filter(Boolean);
      resolve({ lines, exitCode: code });
    });
  });
}

describe('Claude Code planner integration', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    const guard = await guardClaude();
    if (guard.skip) return; // node:test skips when before() doesn't throw but test uses skip
  });

  it('spawns subprocess and receives stream-json output', { timeout: 30_000 }, async (t) => {
    const guard = await guardClaude();
    if (guard.skip) { t.skip(); return; }

    const { lines, exitCode } = await collectStream('claude', [
      '-p', 'What is 2+2?', '--output-format', 'stream-json',
    ]);

    expect(exitCode).toBe(0);
    expect(lines.length).toBeGreaterThan(0);

    const parsed = lines.map((l) => JSON.parse(l));
    const hasContent = parsed.some(
      (e: Record<string, unknown>) => e.type === 'assistant' || e.type === 'result',
    );
    expect(hasContent).toBeTruthy();

    const contentEvent = parsed.find(
      (e: Record<string, unknown>) => e.type === 'assistant' || e.type === 'result',
    );
    expect(contentEvent).toBeTruthy();

    if (contentEvent.type === 'result') {
      expect(typeof contentEvent.result === 'string' && contentEvent.result.length > 0).toBeTruthy();
    } else {
      expect(contentEvent.message).toBeTruthy();
    }
  });

  it('extracts usage data from result event', { timeout: 30_000 }, async (t) => {
    const guard = await guardClaude();
    if (guard.skip) { t.skip(); return; }

    const { lines } = await collectStream('claude', [
      '-p', 'Reply with just the word "hello"', '--output-format', 'stream-json',
    ]);

    const parsed = lines.map((l) => JSON.parse(l));
    const resultEvent = parsed.find((e: Record<string, unknown>) => e.type === 'result');

    expect(resultEvent).toBeTruthy();
    expect(resultEvent.total_cost_usd !== undefined || resultEvent.usage !== undefined).toBeTruthy();

    if (resultEvent.usage) {
      expect(resultEvent.usage.input_tokens).toBeGreaterThan(0);
      expect(resultEvent.usage.output_tokens).toBeGreaterThan(0);
    }
  });

  it('handles empty prompt gracefully', { timeout: 30_000 }, async (t) => {
    const guard = await guardClaude();
    if (guard.skip) { t.skip(); return; }

    const { lines, exitCode } = await collectStream('claude', [
      '-p', '', '--output-format', 'stream-json',
    ]);

    // Either errors out (non-zero exit) or returns an empty/error response
    if (exitCode !== 0) {
      expect(exitCode).not.toBe(null);
    } else {
      // If it succeeds, it should still produce parseable output
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });
});
