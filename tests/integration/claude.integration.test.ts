import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
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
  before(async () => {
    const guard = await guardClaude();
    if (guard.skip) return; // node:test skips when before() doesn't throw but test uses skip
  });

  it('spawns subprocess and receives stream-json output', { timeout: 30_000 }, async (t) => {
    const guard = await guardClaude();
    if (guard.skip) { t.skip(guard.skip); return; }

    const { lines, exitCode } = await collectStream('claude', [
      '-p', 'What is 2+2?', '--output-format', 'stream-json',
    ]);

    assert.equal(exitCode, 0, 'claude process should exit cleanly');
    assert(lines.length > 0, 'should produce at least one NDJSON line');

    const parsed = lines.map((l) => JSON.parse(l));
    const hasContent = parsed.some(
      (e: Record<string, unknown>) => e.type === 'assistant' || e.type === 'result',
    );
    assert(hasContent, 'should contain an assistant or result event');

    const contentEvent = parsed.find(
      (e: Record<string, unknown>) => e.type === 'assistant' || e.type === 'result',
    );
    assert(contentEvent, 'content event must exist');

    if (contentEvent.type === 'result') {
      assert(typeof contentEvent.result === 'string' && contentEvent.result.length > 0, 'result text should be non-empty');
    } else {
      assert(contentEvent.message, 'assistant event should have a message');
    }
  });

  it('extracts usage data from result event', { timeout: 30_000 }, async (t) => {
    const guard = await guardClaude();
    if (guard.skip) { t.skip(guard.skip); return; }

    const { lines } = await collectStream('claude', [
      '-p', 'Reply with just the word "hello"', '--output-format', 'stream-json',
    ]);

    const parsed = lines.map((l) => JSON.parse(l));
    const resultEvent = parsed.find((e: Record<string, unknown>) => e.type === 'result');

    assert(resultEvent, 'should have a result event');
    assert(resultEvent.total_cost_usd !== undefined || resultEvent.usage !== undefined,
      'result event should contain cost or usage data');

    if (resultEvent.usage) {
      assert(resultEvent.usage.input_tokens > 0, 'input tokens should be > 0');
      assert(resultEvent.usage.output_tokens > 0, 'output tokens should be > 0');
    }
  });

  it('handles empty prompt gracefully', { timeout: 30_000 }, async (t) => {
    const guard = await guardClaude();
    if (guard.skip) { t.skip(guard.skip); return; }

    const { lines, exitCode } = await collectStream('claude', [
      '-p', '', '--output-format', 'stream-json',
    ]);

    // Either errors out (non-zero exit) or returns an empty/error response
    if (exitCode !== 0) {
      assert(exitCode !== null, 'should have a defined exit code on error');
    } else {
      // If it succeeds, it should still produce parseable output
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), 'output lines should be valid JSON');
      }
    }
  });
});
