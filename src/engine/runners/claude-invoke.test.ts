import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClaudePlannerStream, runClaudeOneShot } from './claude-invoke.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

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
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(shimPath, `#!/bin/bash\n${body}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

/**
 * Installs a `claude` shim that records its argv and the stdin it received to
 * files in `shimDir`, then emits a single result event. Lets a test assert what
 * the invoke module actually delivered to the subprocess.
 */
function installRecordingShim(): { argvFile: string; stdinFile: string } {
  const argvFile = join(shimDir, 'argv.txt');
  const stdinFile = join(shimDir, 'stdin.txt');
  const shimPath = join(shimDir, 'claude');
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `cat > '${stdinFile}'`,
    `printf '%s\\n' '{"type":"result","result":"ok"}'`,
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return { argvFile, stdinFile };
}

/**
 * Installs a `claude` shim that emits the given stream-json lines and then exits
 * with a non-zero code, mirroring a real API-level failure where claude exits 1
 * with empty stderr and the human-readable reason living only in the result event.
 */
function installFailingShim(bodyLines: string[], exitCode: number): string {
  const shimPath = join(shimDir, 'claude');
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(shimPath, `#!/bin/bash\n${body}\nexit ${exitCode}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

function makeImage(path: string): Attachment {
  return {
    id: path,
    kind: 'image',
    path,
    mimeType: 'image/png',
    sizeBytes: 1,
  };
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
    // The question parser recognises <!-- Q:{json} --> markers inline in assistant text.
    const q = { id: 'q1', type: 'input', text: 'which port?' };
    const marker = `<!-- Q:${JSON.stringify(q)} -->`;
    // The marker must not be split across stream lines; embed it fully in one text block.
    // Also we must escape quotes and braces for bash single-quotes and JSON-inside-JSON.
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: marker }] },
    });
    installShim([assistantEvent, '{"type":"result","result":""}']);

    const questions: Array<{ id: string }> = [];
    await runClaudePlannerStream({
      prompt: 'p',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
      onQuestion: (qs) => {
        for (const parsed of qs) questions.push(parsed);
      },
    });

    expect(questions.map((it) => it.id)).toContain('q1');
  });

  it('rejects with CLAUDE_NOT_FOUND message when `claude` is not on PATH', async () => {
    // Point PATH at an empty dir that has no `claude` shim.
    process.env['PATH'] = createTempDir('empty-path');
    try {
      await expect(
        runClaudePlannerStream({
          prompt: 'p',
          projectDir: shimDir,
          sessionId: null,
          onOutput: () => {},
        }),
      ).rejects.toThrow(/Claude Code CLI not found/);
    } finally {
      cleanupTempDir(process.env['PATH']!);
    }
  });

  it('rejects without spawning when the signal is already aborted', async () => {
    installShim(['{"type":"result","result":"should not run"}']);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('surfaces the in-band is_error reason when claude exits 1 with empty stderr', async () => {
    // Real API failures: claude exits 1 with EMPTY stderr and the human-readable
    // reason lives only in the stream-json result event with is_error: true.
    installFailingShim(
      [
        '{"type":"system","session_id":"sess-fail"}',
        '{"type":"result","is_error":true,"result":"Credit balance is too low","session_id":"sess-fail"}',
      ],
      1,
    );

    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: expect.stringContaining('Credit balance is too low'),
    });
  });

  it('surfaces an is_error result as a failure even when claude exits 0', async () => {
    // claude can report an API-level failure in the result event (is_error: true)
    // while still exiting 0; that reason must surface as a failure, not silent success.
    installShim([
      '{"type":"system","session_id":"sess-zero"}',
      '{"type":"result","is_error":true,"result":"Overloaded: please retry","session_id":"sess-zero"}',
    ]);

    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: expect.stringContaining('Overloaded: please retry'),
    });
  });

  it('embeds image attachments as prompt references in stdin, never as --image argv', async () => {
    const { argvFile, stdinFile } = installRecordingShim();

    await runClaudePlannerStream({
      prompt: 'describe the screenshot',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
      images: [makeImage('/tmp/a.png'), makeImage('/tmp/b.png')],
    });

    const argv = readFileSync(argvFile, 'utf8');
    const stdin = readFileSync(stdinFile, 'utf8');

    // The claude CLI has no --image flag; it must never appear in the argv.
    expect(argv).not.toContain('--image');
    expect(argv).not.toContain('/tmp/a.png');

    // Attachment paths reach the model as prompt references it can Read itself.
    expect(stdin).toContain('[image attachment: /tmp/a.png]');
    expect(stdin).toContain('[image attachment: /tmp/b.png]');
    expect(stdin).toContain('describe the screenshot');
  });

  it('passes effort as an --effort argv flag, never as an /effort stdin prefix', async () => {
    const { argvFile, stdinFile } = installRecordingShim();

    await runClaudePlannerStream({
      prompt: 'go',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
      effort: 'high',
      images: [makeImage('/tmp/a.png')],
    });

    const argv = readFileSync(argvFile, 'utf8').split('\n');
    const stdin = readFileSync(stdinFile, 'utf8');

    // Effort reaches the CLI as a flag the binary understands, not a slash command
    // that the planner subprocess would reject and discard the whole prompt over.
    const effortIdx = argv.indexOf('--effort');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[effortIdx + 1]).toBe('high');

    // The prompt itself must never be prefixed with the unsupported /effort command.
    expect(stdin).not.toContain('/effort');
    expect(stdin.startsWith('[image attachment: /tmp/a.png]')).toBe(true);
    expect(stdin).toContain('go');
  });

  it('omits the --effort flag entirely when no effort is configured', async () => {
    const { argvFile } = installRecordingShim();

    await runClaudePlannerStream({
      prompt: 'go',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
    });

    const argv = readFileSync(argvFile, 'utf8');
    expect(argv).not.toContain('--effort');
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
      await expect(
        runClaudeOneShot({
          prompt: 'p',
          projectDir: shimDir,
          onOutput: () => {},
        }),
      ).rejects.toThrow(/Claude Code CLI not found/);
    } finally {
      cleanupTempDir(process.env['PATH']!);
    }
  });

  it('rejects without spawning when the signal is already aborted', async () => {
    installShim(['{"type":"result","result":"should not run"}']);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      runClaudeOneShot({
        prompt: 'p',
        projectDir: shimDir,
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes effort as an --effort argv flag and leaves stdin as the raw prompt', async () => {
    const { argvFile, stdinFile } = installRecordingShim();

    await runClaudeOneShot({
      prompt: 'escalate me',
      projectDir: shimDir,
      onOutput: () => {},
      effort: 'xhigh',
    });

    const argv = readFileSync(argvFile, 'utf8').split('\n');
    const stdin = readFileSync(stdinFile, 'utf8');

    const effortIdx = argv.indexOf('--effort');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[effortIdx + 1]).toBe('xhigh');
    expect(stdin).not.toContain('/effort');
    expect(stdin.startsWith('escalate me')).toBe(true);
  });

  it('surfaces an is_error result as a failure even when claude exits 0', async () => {
    installShim(['{"type":"result","is_error":true,"result":"Credit balance is too low"}']);

    await expect(
      runClaudeOneShot({
        prompt: 'p',
        projectDir: shimDir,
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: expect.stringContaining('Credit balance is too low'),
    });
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
