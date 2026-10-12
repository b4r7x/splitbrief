import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import {
  cliAuthChannelHostStateAccess,
  defaultCliAuthChannel,
} from '../../core/runners/cli-tool-catalog.js';
import { createClaudeCodePlanner } from './claude-code.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { writeCommandShim } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import { sandboxRoot } from '../runners/sandbox-state-paths.js';
import { callPlanner } from '#testing/helpers/planner-call.js';

let shimDir: string;
let projectDir: string;
let originalPath: string | undefined;
let originalAnthropicApiKey: string | undefined;
let originalOpenAiApiKey: string | undefined;

beforeEach(() => {
  shimDir = createTempDir('claude-code-planner-shim');
  projectDir = createTempDir('claude-code-planner-project');
  originalPath = process.env['PATH'];
  originalAnthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  originalOpenAiApiKey = process.env['OPENAI_API_KEY'];
});

afterEach(() => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  if (originalAnthropicApiKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = originalAnthropicApiKey;
  if (originalOpenAiApiKey === undefined) delete process.env['OPENAI_API_KEY'];
  else process.env['OPENAI_API_KEY'] = originalOpenAiApiKey;
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

async function trustedClaudeExecutable(): Promise<CliExecutableIdentity> {
  return resolveCliExecutable({ command: 'claude', projectDir: projectDir });
}

async function createTrustedClaudeCodePlanner(
  opts: Parameters<typeof createClaudeCodePlanner>[0],
): Promise<ReturnType<typeof createClaudeCodePlanner>> {
  return createClaudeCodePlanner({
    ...opts,
    trustedCli: { executable: await trustedClaudeExecutable() },
  });
}

function isolateHome(): { dir: string; restore: () => void } {
  const homeDir = createTempDir('claude-code-planner-home');
  const original = {
    HOME: process.env['HOME'],
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
    XDG_DATA_HOME: process.env['XDG_DATA_HOME'],
  };
  process.env['HOME'] = homeDir;
  process.env['XDG_CONFIG_HOME'] = join(homeDir, '.config');
  process.env['XDG_DATA_HOME'] = join(homeDir, '.local', 'share');
  return {
    dir: homeDir,
    restore: () => {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      cleanupTempDir(homeDir);
    },
  };
}

function installAuthRecordingShim(): string {
  const envFile = join(shimDir, 'auth-env.txt');
  const shimPath = join(shimDir, 'claude');
  const script = [
    '#!/bin/bash',
    'cat >/dev/null',
    `printf '%s|%s\n' "$ANTHROPIC_API_KEY" "$OPENAI_API_KEY" > '${envFile}'`,
    `printf '%s\n' '${JSON.stringify({ type: 'result', result: 'auth-ok' })}'`,
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return envFile;
}

describe('createClaudeCodePlanner escalation', () => {
  it('forwards sandboxEnv to the spawned claude subprocess during escalateFull', async () => {
    const envMarkerFile = join(shimDir, 'env-marker.txt');
    const restoreCompatibleShim = activateCompatibleCliShim(
      installCompatibleCliShim({
        directory: shimDir,
        tool: 'claude-code',
        authChannel: 'session',
        invocation: {
          marker: { path: envMarkerFile, environment: 'SPLITBRIEF_SANDBOX_MARKER' },
          stdoutLines: [
            JSON.stringify({
              type: 'result',
              result: `\`\`\`ts
export const x = 1;
\`\`\``,
            }),
          ],
        },
      }),
    );

    try {
      const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });
      const result = await planner.escalateFull({
        task: makeTask(),
        error: 'boom',
        projectDir,
        callbacks: { onOutput: () => {} },
        sandboxEnv: {
          PATH: `${shimDir}:${originalPath ?? ''}`,
          SPLITBRIEF_SANDBOX_MARKER: 'forwarded',
        },
      });

      expect(result).toMatchObject({ success: true, code: 'export const x = 1;' });
      expect(existsSync(envMarkerFile)).toBe(true);
      expect(readFileSync(envMarkerFile, 'utf8').trim()).toBe('forwarded');
    } finally {
      restoreCompatibleShim();
    }
  });
});

describe('createClaudeCodePlanner planning', () => {
  it('defaults the omitted auth channel to the session channel', async () => {
    const envFile = installAuthRecordingShim();
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-canary';
    process.env['OPENAI_API_KEY'] = 'openai-canary';
    const home = isolateHome();
    mkdirSync(join(home.dir, '.claude'), { recursive: true });
    writeFileSync(join(home.dir, '.claude', '.credentials.json'), '{"session":"stub"}\n', 'utf8');

    try {
      const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });
      await planner.review('prompt', projectDir, { onOutput: () => {} });

      expect(readFileSync(envFile, 'utf8').trim()).toBe('|');
      const staged = join(
        sandboxRoot(projectDir, 'planner', 'claude-code'),
        'home',
        '.claude',
        '.credentials.json',
      );
      // The session channel reaches the child the way the platform allows: a
      // read-only snapshot where the credential is a file, the host account
      // where it is an OS keychain item and nothing can be copied.
      expect(existsSync(staged)).toBe(
        cliAuthChannelHostStateAccess(defaultCliAuthChannel('claude-code')) === 'bridged-files',
      );
    } finally {
      home.restore();
    }
  });

  it.each(['api-key', 'session'] as const)(
    'refuses an explicit unproven %s auth channel before spawning',
    async (authChannel) => {
      const envFile = installAuthRecordingShim();
      process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
      process.env['ANTHROPIC_API_KEY'] = 'anthropic-canary';
      process.env['OPENAI_API_KEY'] = 'openai-canary';

      const planner = await createTrustedClaudeCodePlanner({ authChannel });

      await expect(
        planner.review('prompt', projectDir, { onOutput: () => {} }),
      ).rejects.toMatchObject({ kind: 'runner-auth-channel-unenforced' });
      expect(existsSync(envFile)).toBe(false);
    },
  );

  // Claude Code 2.1.284 answers `--resume` of a session it no longer has with exactly this
  // (captured live 2026-09-29): an error result on stdout, the same line on stderr, exit 1.
  it('drops an expired session and fails the call, so the next call starts a fresh one', async () => {
    const argvLog = join(shimDir, 'argv-log.txt');
    const expiredLine = 'No conversation found with session ID: sess-old';
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        `printf '%s ' "$@" >> '${argvLog}'`,
        `printf '\\n' >> '${argvLog}'`,
        'if printf \'%s\\n\' "$@" | grep -q "^--resume$"; then',
        `  printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: 'sess-old', usage: { input_tokens: 0, output_tokens: 0 }, errors: [expiredLine] })}'`,
        `  printf '%s\\n' '${expiredLine}' >&2`,
        '  exit 1',
        'fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-new', result: '# Research\nbody', usage: { input_tokens: 2, output_tokens: 2 } }).replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
    const expiredSessionIds: string[] = [];
    const reportedSessionIds: string[] = [];
    const planner = await createTrustedClaudeCodePlanner({
      authChannel: undefined,
      initialSessionId: 'sess-old',
    });
    const callbacks = {
      onOutput: () => {},
      onSessionId: (sessionId: string) => reportedSessionIds.push(sessionId),
      onSessionExpired: (sessionId: string) => expiredSessionIds.push(sessionId),
    };

    await expect(
      callPlanner(planner, { prompt: 'expired', projectDir, callbacks }),
    ).rejects.toThrow(expiredLine);
    expect(expiredSessionIds).toEqual(['sess-old']);
    expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toHaveLength(1);

    const rerun = await callPlanner(planner, {
      prompt: 'rerun',
      projectDir,
      callbacks,
    });

    expect(rerun.text).toBe('# Research\nbody');
    const [expired, fresh] = readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(expired).toContain('--resume sess-old');
    expect(fresh).not.toContain('--resume');
    expect(reportedSessionIds).toEqual(['sess-new']);
  });

  it.each([false, true])('quarantines mismatched resume (init=%s)', async (withInit) => {
    const argvLog = join(shimDir, 'argv-log.txt');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat >/dev/null',
        `printf '%s ' "$@" >> '${argvLog}'`,
        `printf '\\n' >> '${argvLog}'`,
        ...(withInit
          ? [
              `printf '%s\\n' '${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-new-unexpected' })}'`,
            ]
          : []),
        `printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-new-unexpected', result: 'stale resumed output', usage: { input_tokens: 1, output_tokens: 1 } }).replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const events: RunnerCallEvent[] = [];
    const reportedSessionIds: string[] = [];
    const expiredSessionIds: string[] = [];
    const output: string[] = [];
    const planner = await createTrustedClaudeCodePlanner({
      authChannel: undefined,
      initialSessionId: 'sess-old',
    });

    await expect(
      callPlanner(planner, {
        prompt: 'mismatch',
        projectDir,
        callbacks: {
          onOutput: (chunk) => output.push(chunk),
          onSessionId: (sessionId) => reportedSessionIds.push(sessionId),
          onSessionExpired: (sessionId) => expiredSessionIds.push(sessionId),
          onCallEvent: (event) => events.push(event),
        },
      }),
    ).rejects.toMatchObject({ kind: 'session-resume-mismatch' });

    expect(expiredSessionIds).toEqual(['sess-old']);
    expect(reportedSessionIds).toEqual([]);
    expect(output.join('\n')).not.toContain('stale resumed output');
    expect(JSON.stringify(events)).not.toContain('sess-new-unexpected');
    expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('captures the native session id as it streams, so the next call resumes a failed one', async () => {
    const tasksMarkdown = `---
id: T001
title: Claude stream capture task
action: create
file: src/claude-stream.ts
depends_on: []
---

### Description
Create the stream capture file.

### Tests
- second call resumes the captured thread
`;
    const argvLog = join(shimDir, 'argv-log.txt');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat >/dev/null',
        `printf '%s ' "$@" >> '${argvLog}'`,
        `printf '\\n' >> '${argvLog}'`,
        'if printf \'%s\\n\' "$@" | grep -q "^--resume$"; then',
        `  printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-stream', result: tasksMarkdown, usage: { input_tokens: 1, output_tokens: 1 } }).replace(/'/g, "'\\''")}'`,
        '  exit 0',
        'fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-stream' }).replace(/'/g, "'\\''")}'`,
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });
    await expect(
      callPlanner(planner, {
        prompt: 'first call dies after the id',
        projectDir,
        callbacks: { onOutput: () => {} },
      }),
    ).rejects.toBeDefined();

    await callPlanner(planner, {
      prompt: 'second call',
      projectDir,
      callbacks: { onOutput: () => {} },
    });

    const calls = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.trim().split(' '));
    expect(calls).toHaveLength(2);
    expect(calls[0] ?? []).not.toContain('--resume');
    const secondArgs = calls[1] ?? [];
    expect(secondArgs.slice(secondArgs.indexOf('--resume'))).toEqual(['--resume', 'sess-stream']);
  });

  it('never re-sends a consumed session id: the second consecutive planner call resumes it', async () => {
    const tasksMarkdown = `---
id: T001
title: Claude retry task
action: create
file: src/claude-retry.ts
depends_on: []
---

### Description
Create the Claude retry file.

### Tests
- retry call executes
`;
    const argvLog = join(shimDir, 'argv-log.txt');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat >/dev/null',
        `printf '%s ' "$@" >> '${argvLog}'`,
        `printf '\\n' >> '${argvLog}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-1', result: tasksMarkdown, usage: { input_tokens: 1, output_tokens: 1 } }).replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });
    await callPlanner(planner, {
      prompt: 'first call',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    await callPlanner(planner, {
      prompt: 'retry call',
      projectDir,
      callbacks: { onOutput: () => {} },
    });

    const calls = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.trim().split(' '));
    expect(calls).toHaveLength(2);
    const firstArgs = calls[0] ?? [];
    const secondArgs = calls[1] ?? [];
    expect(firstArgs).not.toContain('--session-id');
    expect(firstArgs).not.toContain('--resume');
    expect(secondArgs).not.toContain('--session-id');
    expect(secondArgs.slice(secondArgs.indexOf('--resume'))).toEqual(['--resume', 'sess-1']);
  });

  it('suppresses native injection events when Claude returns a different session id', async () => {
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat >/dev/null',
        `printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-new-unexpected', result: 'stale injected output', usage: { input_tokens: 2, output_tokens: 2 } }).replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const events: RunnerCallEvent[] = [];
    const planner = await createTrustedClaudeCodePlanner({
      authChannel: undefined,
      initialSessionId: 'sess-old',
    });

    await expect(
      planner.injectUserTurn?.({
        text: 'continue',
        projectDir,
        callbacks: {
          onCallEvent: (event) => events.push(event),
        },
      }),
    ).rejects.toMatchObject({
      kind: 'session-resume-mismatch',
      data: { expectedId: 'sess-old', actualId: 'sess-new-unexpected' },
    });

    expect(events).toEqual([]);
  });

  it('reports a user turn not ready without spawning while no native session exists', async () => {
    const marker = join(shimDir, 'spawned');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(shimPath, ['#!/bin/bash', `touch '${marker}'`, ''].join('\n'), 'utf8');
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const events: RunnerCallEvent[] = [];
    const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });

    await expect(
      planner.injectUserTurn?.({
        text: 'use JWT instead',
        projectDir,
        callbacks: { onCallEvent: (event) => events.push(event) },
      }),
    ).resolves.toEqual({ status: 'not-delivered', reason: 'not-ready' });

    expect(existsSync(marker)).toBe(false);
    expect(events).toEqual([]);
  });

  it('reports a native user turn delivered even when Claude returns no usage', async () => {
    writeCommandShim({
      dir: shimDir,
      command: 'claude',
      lines: [JSON.stringify({ type: 'result', session_id: 'sess-old', result: 'noted' })],
    });
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const planner = await createTrustedClaudeCodePlanner({
      authChannel: undefined,
      initialSessionId: 'sess-old',
    });

    await expect(planner.injectUserTurn?.({ text: 'continue', projectDir })).resolves.toEqual({
      status: 'delivered',
      usage: null,
    });
  });

  it('threads a configured idleWarnMs override into the spawn', async () => {
    writeCommandShim({
      dir: shimDir,
      command: 'claude',
      lines: [JSON.stringify({ type: 'result', result: 'slow response' })],
      sleepSeconds: 0.15,
    });
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const events: RunnerCallEvent[] = [];
    const planner = await createTrustedClaudeCodePlanner({
      authChannel: undefined,
      idleWarnMs: 30,
    });

    const result = await planner.review('prompt', projectDir, {
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result.text).toContain('slow response');
    const stalled = events.find((event) => event.type === 'call_stalled');
    expect(stalled).toMatchObject({ type: 'call_stalled', silentMs: expect.any(Number) });
  });

  it('keeps only the terminal result content when the final response diverges from partials', async () => {
    writeCommandShim({
      dir: shimDir,
      command: 'claude',
      lines: [
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'PARTIAL DIVERGENT CONTENT' },
          },
        }),
        JSON.stringify({
          type: 'result',
          result: 'FINAL RESULT ONLY',
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
      ],
    });
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });
    const result = await planner.review('prompt', projectDir, { onOutput: () => {} });

    // REQ-013: only the authoritative final assistant response is content; the
    // divergent partial is evidence at most and never joins the Brief.
    expect(result.text).toBe('FINAL RESULT ONLY');
    expect(result.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 });
  });

  it('delivers instructions through the admitted stdin prompt, never through argv', async () => {
    const stdinFile = join(shimDir, 'stdin.txt');
    const argvFile = join(shimDir, 'argv.txt');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `cat > '${stdinFile}'`,
        `printf '%s\\n' "$@" > '${argvFile}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'result', result: 'ok' })}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });
    await planner.review('REPO-INSTRUCTIONS-MARKER\n\nproceed', projectDir, {
      onOutput: () => {},
    });

    // The prompt is the sole instruction channel; the argv stays the admitted
    // vector and never carries instruction content.
    expect(readFileSync(stdinFile, 'utf8')).toContain('REPO-INSTRUCTIONS-MARKER');
    expect(readFileSync(argvFile, 'utf8')).not.toContain('REPO-INSTRUCTIONS-MARKER');
  });

  it('refuses a configured planner arg that adds a project root outside the invocation', async () => {
    const spawnedMarker = join(shimDir, 'spawned.txt');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `touch '${spawnedMarker}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'result', result: 'never reached' })}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
    const home = isolateHome();

    try {
      const planner = await createTrustedClaudeCodePlanner({
        authChannel: undefined,
        args: ['--add-dir', '/srv/shared-context'],
      });

      // REQ-018: added roots are adapter-owned. The configured arg is rejected
      // before any process spawns, so the shim never runs.
      await expect(
        planner.review('prompt', projectDir, { onOutput: () => {} }),
      ).rejects.toMatchObject({
        kind: 'cli-argument-conflict',
        data: { conflicts: ['--add-dir'] },
      });
      expect(existsSync(spawnedMarker)).toBe(false);
    } finally {
      home.restore();
    }
  });

  it('refuses a configured planner arg that overrides the invocation SPLITBRIEF owns', async () => {
    writeCommandShim({
      dir: shimDir,
      command: 'claude',
      lines: [JSON.stringify({ type: 'result', result: 'never reached' })],
    });
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
    const home = isolateHome();

    try {
      const planner = await createTrustedClaudeCodePlanner({
        authChannel: undefined,
        args: ['--permission-mode', 'bypassPermissions'],
      });

      await expect(
        planner.review('prompt', projectDir, { onOutput: () => {} }),
      ).rejects.toMatchObject({
        kind: 'cli-argument-conflict',
        data: { conflicts: ['--permission-mode'] },
      });
    } finally {
      home.restore();
    }
  });
});

describe('confirmed Claude resume streaming', () => {
  it.each([
    { abort: false, injection: false },
    { abort: true, injection: false },
    { abort: false, injection: true },
  ])('streams before completion: $abort / $injection', async ({ abort, injection }) => {
    const gate = join(shimDir, 'released');
    const finished = join(shimDir, 'finished');
    const shim = join(shimDir, 'claude');
    const frames = [
      { type: 'system', subtype: 'init', session_id: 'sess-old' },
      {
        type: 'assistant',
        session_id: 'sess-old',
        message: { content: [{ type: 'text', text: 'Which module?' }] },
      },
    ];
    writeFileSync(
      shim,
      `#!${process.execPath}
const fs = require('node:fs');
fs.readFileSync(0);
${frames.map((frame) => `console.log(${JSON.stringify(JSON.stringify(frame))});`).join('\n')}
const deadline = setTimeout(() => process.exit(3), 3000);
const wait = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(gate)})) return;
  clearInterval(wait); clearTimeout(deadline);
  fs.writeFileSync(${JSON.stringify(finished)}, 'done');
  console.log(JSON.stringify({type:'result',session_id:'sess-old',result:'Which module?'}));
}, 10);
`,
    );
    chmodSync(shim, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
    const planner = await createTrustedClaudeCodePlanner({
      authChannel: undefined,
      initialSessionId: 'sess-old',
      model: 'sonnet',
      effort: 'high',
    });
    const controller = new AbortController();
    const events: RunnerCallEvent[] = [];
    const output: string[] = [];
    const release = (text: string) => {
      expect(existsSync(finished)).toBe(false);
      expect(events.some((event) => event.type === 'call_started')).toBe(true);
      output.push(text);
      if (abort) controller.abort();
      else writeFileSync(gate, 'release');
    };
    const onCallEvent = (event: RunnerCallEvent) => {
      events.push(event);
      if (injection && event.type === 'call_text_delta' && event.channel === 'assistant')
        release(event.text);
    };
    if (injection) {
      expect(
        await planner.injectUserTurn?.({ text: 'answer', projectDir, callbacks: { onCallEvent } }),
      ).toMatchObject({ status: 'delivered' });
    } else {
      const result = callPlanner(planner, {
        prompt: 'refactor',
        projectDir,
        callbacks: {
          signal: controller.signal,
          onCallEvent,
          onOutput: release,
        },
      });
      if (abort) await expect(result).rejects.toThrow();
      else await result;
    }
    expect(output).toEqual(['Which module?']);
    expect(events.filter((event) => event.type === 'call_started')).toHaveLength(1);
    expect(
      events.every(
        (event) =>
          event.runnerName === 'claude' &&
          event.model === 'sonnet' &&
          event.axes?.join() === 'high',
      ),
    ).toBe(true);
  });

  it.each(['expired', 'mismatch'])(
    'does not retry a confirmed session after %s',
    async (failure) => {
      const shim = join(shimDir, 'claude');
      const frames = [
        { type: 'system', subtype: 'init', session_id: 'sess-old' },
        {
          type: 'result',
          session_id: failure === 'mismatch' ? 'sess-other' : 'sess-old',
          is_error: failure === 'expired',
          result: failure === 'expired' ? 'session not found' : 'Which module?',
        },
      ];
      writeFileSync(
        shim,
        `#!${process.execPath}\nrequire('node:fs').readFileSync(0);\n${frames.map((frame) => `console.log(${JSON.stringify(JSON.stringify(frame))});`).join('\n')}\n`,
      );
      chmodSync(shim, 0o755);
      process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
      const planner = await createTrustedClaudeCodePlanner({
        authChannel: undefined,
        initialSessionId: 'sess-old',
      });
      const events: RunnerCallEvent[] = [];
      await expect(
        callPlanner(planner, {
          prompt: 'refactor',
          projectDir,
          callbacks: {
            onOutput: () => {},
            onCallEvent: (event) => events.push(event),
          },
        }),
      ).rejects.toMatchObject({ kind: 'session-resume-failed' });
      expect(events.filter((event) => event.type === 'call_started')).toHaveLength(1);
      const injectionEvents: RunnerCallEvent[] = [];
      await expect(
        planner.injectUserTurn?.({
          text: 'continue',
          projectDir,
          callbacks: { onCallEvent: (event) => injectionEvents.push(event) },
        }),
      ).rejects.toMatchObject({ kind: 'session-resume-failed' });
      expect(injectionEvents.filter((event) => event.type === 'call_started')).toHaveLength(1);
    },
  );
});

describe('createClaudeCodePlanner typed calls', () => {
  // A planner call runs on its planning stream; a review call is the one-shot path.
  it.each(['planner', 'reviewer'] as const)(
    'passes an inline JSON schema to a typed %s call and returns the structured answer',
    async (seat) => {
      const argvFile = join(shimDir, 'argv.txt');
      const shimPath = join(shimDir, 'claude');
      writeFileSync(
        shimPath,
        [
          '#!/bin/bash',
          'cat >/dev/null',
          `printf '%s\\n' "$@" > '${argvFile}'`,
          `printf '%s\\n' '${JSON.stringify({
            type: 'result',
            is_error: false,
            result: '',
            session_id: 's-9',
            structured_output: { answer: 'y', count: 2 },
          })}'`,
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(shimPath, 0o755);
      process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

      const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });
      const result = await planner
        .typedCall({ projectDir, callbacks: { onOutput: () => {} }, seat })
        .invoke({ prompt: 'q', schema: { json: { type: 'object' }, name: 'probe' } });

      const argv = readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
      expect(argv).toContain('--json-schema');
      const schemaIndex = argv.indexOf('--json-schema');
      expect(argv.slice(schemaIndex, schemaIndex + 2)).toEqual([
        '--json-schema',
        '{"type":"object"}',
      ]);
      if (result.status !== 'completed') throw new Error('expected a completed typed call');
      expect(result.structured).toEqual({ answer: 'y', count: 2 });
    },
  );

  it('reports native typed output for the Claude Code planner', async () => {
    writeCommandShim({ dir: shimDir, command: 'claude', lines: [] });
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });

    expect(
      planner.typedCall({ projectDir, callbacks: { onOutput: () => {} }, seat: 'planner' })
        .typedOutput,
    ).toBe('native');
  });
});
