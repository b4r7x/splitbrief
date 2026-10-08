import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { runClaudeOneShot as runClaudeOneShotImpl } from './invoke.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import {
  installClaudeNodeShim,
  installClaudeRecordingShim,
  installClaudeShim,
} from '#testing/helpers/claude-cli-shim.js';

let shimDir: string;
let projectDir: string;
let restorePath: () => void;
let originalAnthropicApiKey: string | undefined;
let originalOpenAiApiKey: string | undefined;

beforeEach(() => {
  shimDir = createTempDir('claude-runner-shim');
  projectDir = createTempDir('claude-runner-project');
  restorePath = prependPath(shimDir);
  originalAnthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  originalOpenAiApiKey = process.env['OPENAI_API_KEY'];
});

afterEach(() => {
  restorePath();
  if (originalAnthropicApiKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = originalAnthropicApiKey;
  if (originalOpenAiApiKey === undefined) delete process.env['OPENAI_API_KEY'];
  else process.env['OPENAI_API_KEY'] = originalOpenAiApiKey;
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

function trustedClaudeExecutable(): CliExecutableIdentity {
  const path = realpathSync(`${shimDir}/claude`);
  const info = statSync(path);
  return {
    path,
    fingerprint: {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
    },
  };
}

function runClaudeOneShot(
  opts: Parameters<typeof runClaudeOneShotImpl>[0],
): ReturnType<typeof runClaudeOneShotImpl> {
  return runClaudeOneShotImpl({ ...opts, executable: trustedClaudeExecutable() });
}

describe('runClaudeOneShot', () => {
  it('keeps streaming past the 1 MB raw stdout retention bound', async () => {
    // A ~13-character text delta rides in a ~200-byte stream_event envelope, so
    // this 104 KB reply is ~1.6 MB of stdout — the volume that used to end the call.
    installClaudeNodeShim(
      shimDir,
      `const chunk = 'brief-text-13';
const write = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
for (let i = 0; i < 8000; i += 1) {
  write({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
    session_id: 'sess',
    parent_tool_use_id: null,
    uuid: 'uuid-' + i,
  });
}
write({ type: 'result', result: chunk.repeat(8000), usage: { input_tokens: 1, output_tokens: 8000 } });`,
    );

    const result = await runClaudeOneShot({
      prompt: 'p',
      projectDir,
      mode: 'escalate',
      onOutput: () => {},
    });

    expect(result.status).toBe('completed');
    expect(result.text).toHaveLength(13 * 8000);
  });

  it('does not inherit ambient credentials when no spawn environment is supplied', async () => {
    const envFile = `${shimDir}/auth-env.txt`;
    installClaudeNodeShim(
      shimDir,
      `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(envFile)}, [process.env.ANTHROPIC_API_KEY ?? '', process.env.OPENAI_API_KEY ?? ''].join('|'));
process.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\\n');`,
    );
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-canary';
    process.env['OPENAI_API_KEY'] = 'openai-canary';

    await runClaudeOneShot({
      prompt: 'p',
      projectDir,
      mode: 'escalate',
      authChannel: 'session',
      onOutput: () => {},
    });

    expect(readFileSync(envFile, 'utf8')).toBe('|');
  });

  it('returns text and usage from the result event', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"reply"}]}}',
      '{"type":"result","result":"reply","usage":{"input_tokens":3,"output_tokens":1}}',
    ]);

    const result = await runClaudeOneShot({
      prompt: 'hi',
      projectDir,
      mode: 'escalate',
      onOutput: () => {},
    });

    expect(result.text).toBe('reply');
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 1,
      counterCoverage: {
        input: 'reported',
        output: 'partial',
        cacheRead: 'missing',
        cacheCreate: 'missing',
        reasoning: 'missing',
      },
      providerTotals: { output: 1 },
    });
  });

  it('passes effort as an --effort argv flag and leaves stdin as the raw prompt', async () => {
    const { argvFile, stdinFile } = installClaudeRecordingShim(shimDir);

    await runClaudeOneShot({
      prompt: 'escalate me',
      projectDir,
      mode: 'escalate',
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
});
