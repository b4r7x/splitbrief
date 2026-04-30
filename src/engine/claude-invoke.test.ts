import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { runClaudePlannerStream, runClaudeOneShot } from './claude-invoke.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { getActiveProcessCount } from '../lib/process/registry.js';

/**
 * These tests exercise the real subprocess seam. `claude-invoke.ts` hardcodes
 * `command: 'claude'`; we intercept by installing a shim named `claude` in a
 * temp directory and prepending that directory to PATH for the duration of
 * each test. The shim emits real stream-json lines so the invoke module's
 * parse + state-aggregation path is observable end-to-end.
 */

let shimDir: string;
let originalPath: string | undefined;

function installShim(bodyLines: string[]): string {
  const shimPath = join(shimDir, 'claude');
  const body = bodyLines.map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`).join('\n');
  writeFileSync(shimPath, `#!/bin/bash\n${body}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

function installFailingShim(exitCode: number, stderr?: string): void {
  const shimPath = join(shimDir, 'claude');
  const stderrLine = stderr ? `printf '%s\\n' '${stderr.replace(/'/g, "'\\''")}' >&2\n` : '';
  writeFileSync(shimPath, `#!/bin/bash\n${stderrLine}exit ${exitCode}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
}

beforeEach(() => {
  shimDir = createTempDir('claude-runner-shim');
  originalPath = process.env['PATH'];
  // Prepend shimDir so our fake `claude` wins over any real installation.
  process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
});

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env['PATH'];
  } else {
    process.env['PATH'] = originalPath;
  }
  cleanupTempDir(shimDir);
});

describe('runClaudePlannerStream', () => {
  it('accumulates streamed text and captures session id + usage from result event', async () => {
    installShim([
      '{"type":"system","session_id":"sess-abc"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}',
      '{"type":"result","result":"Hello world","session_id":"sess-abc","usage":{"input_tokens":42,"output_tokens":7}}',
    ]);

    const chunks: string[] = [];
    const result = await runClaudePlannerStream({
      prompt: 'do thing',
      projectDir: shimDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
    });

    expect(result.sessionId).toBe('sess-abc');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(chunks.join('')).toContain('Hello world');
    expect(result.text).toBe('Hello world');
  });

  it('preserves initial sessionId when stream carries none', async () => {
    installShim([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
      '{"type":"result","result":"ok"}',
    ]);

    const result = await runClaudePlannerStream({
      prompt: 'p',
      projectDir: shimDir,
      sessionId: 'pre-existing-session',
      onOutput: () => {},
    });

    expect(result.sessionId).toBe('pre-existing-session');
  });

  it('renders tool-use events into a formatted tool summary line', async () => {
    installShim([
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/etc/hosts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}',
      '{"type":"result","result":""}',
    ]);

    const chunks: string[] = [];
    await runClaudePlannerStream({
      prompt: 'p',
      projectDir: shimDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
    });

    const output = chunks.join('');
    expect(output).toContain('Read /etc/hosts');
    expect(output).toContain('Bash ls -la');
  });

  it('emits questions via onQuestion when the text stream contains question markers', async () => {
    // question-parser recognises <!-- Q:{json} --> markers inline in assistant text.
    const q = { id: 'q1', type: 'input', text: 'which port?' };
    const marker = `<!-- Q:${JSON.stringify(q)} -->`;
    // The marker must not be split across stream lines; embed it fully in one text block.
    // Also we must escape quotes and braces for bash single-quotes and JSON-inside-JSON.
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: marker }] },
    });
    installShim([
      assistantEvent,
      '{"type":"result","result":""}',
    ]);

    const questions: Array<{ id: string }> = [];
    await runClaudePlannerStream({
      prompt: 'p',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
      onQuestion: (qs) => { for (const parsed of qs) questions.push(parsed); },
    });

    expect(questions.map((it) => it.id)).toContain('q1');
  });

  it('rejects with CLAUDE_NOT_FOUND message when `claude` is not on PATH', async () => {
    // Point PATH at an empty dir that has no `claude` shim.
    process.env['PATH'] = createTempDir('empty-path');
    try {
      await expect(runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
      })).rejects.toThrow(/Claude Code CLI not found/);
    } finally {
      cleanupTempDir(process.env['PATH']!);
    }
  });

  it('does not leave subprocesses in the active-process registry after success', async () => {
    installShim(['{"type":"result","result":""}']);
    const before = getActiveProcessCount();
    await runClaudePlannerStream({
      prompt: 'p',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
    });
    expect(getActiveProcessCount()).toBe(before);
  });

  it('does not leave subprocesses in the active-process registry after failure', async () => {
    installFailingShim(1, 'something broke');
    const before = getActiveProcessCount();
    try {
      await runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
      });
    } catch {
      // expected
    }
    expect(getActiveProcessCount()).toBe(before);
  });
});

describe('runClaudeOneShot', () => {
  it('returns text and usage from the result event', async () => {
    installShim([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"reply"}]}}',
      '{"type":"result","result":"reply","usage":{"input_tokens":3,"output_tokens":1}}',
    ]);

    const result = await runClaudeOneShot({
      prompt: 'hi',
      projectDir: shimDir,
      onOutput: () => {},
    });

    expect(result.text).toBe('reply');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it('streams text chunks to onOutput in order they arrive', async () => {
    installShim([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"one "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"two "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"three"}]}}',
      '{"type":"result","result":"one two three"}',
    ]);

    const chunks: string[] = [];
    await runClaudeOneShot({
      prompt: 'p',
      projectDir: shimDir,
      onOutput: (text) => chunks.push(text),
    });

    const streamed = chunks.join('');
    expect(streamed).toContain('one ');
    expect(streamed).toContain('two ');
    expect(streamed).toContain('three');
    // Order preserved.
    expect(streamed.indexOf('one')).toBeLessThan(streamed.indexOf('two'));
    expect(streamed.indexOf('two')).toBeLessThan(streamed.indexOf('three'));
  });

  it('rejects with CLAUDE_NOT_FOUND when claude binary is missing', async () => {
    process.env['PATH'] = createTempDir('empty-path-2');
    try {
      await expect(runClaudeOneShot({
        prompt: 'p',
        projectDir: shimDir,
        onOutput: () => {},
      })).rejects.toThrow(/Claude Code CLI not found/);
    } finally {
      cleanupTempDir(process.env['PATH']!);
    }
  });

  it('returns empty text + null usage when the stream contains no result event', async () => {
    installShim([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
      // no result event — process exits 0 after assistant event only
    ]);

    const result = await runClaudeOneShot({
      prompt: 'p',
      projectDir: shimDir,
      onOutput: () => {},
    });

    // The accumulated text from assistant chunks should still surface.
    expect(result.text).toBe('partial');
    expect(result.usage).toBeNull();
  });
});
