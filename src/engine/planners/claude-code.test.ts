import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import { SANDBOX_DIR } from '../../core/paths.js';
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
  return resolveCliExecutable('claude', projectDir);
}

async function createTrustedClaudeCodePlanner(
  opts: Parameters<typeof createClaudeCodePlanner>[0],
): Promise<ReturnType<typeof createClaudeCodePlanner>> {
  return createClaudeCodePlanner({
    ...opts,
    trustedCli: { executable: await trustedClaudeExecutable() },
  });
}

function installAuthRecordingShim(): string {
  const envFile = join(shimDir, 'auth-env.txt');
  const shimPath = join(shimDir, 'claude');
  const script = [
    '#!/bin/bash',
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
      const planner = await createTrustedClaudeCodePlanner({ authChannel: 'session' });
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
    const homeDir = createTempDir('claude-code-planner-home');
    const originalHome = process.env['HOME'];
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', '.credentials.json'), '{"session":"stub"}\n', 'utf8');
    process.env['HOME'] = homeDir;

    try {
      const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });
      await planner.review('prompt', projectDir, { onOutput: () => {} });

      expect(readFileSync(envFile, 'utf8').trim()).toBe('|');
      expect(
        existsSync(join(projectDir, SANDBOX_DIR, 'home', '.claude', '.credentials.json')),
      ).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      cleanupTempDir(homeDir);
    }
  });

  it('forwards only the selected API-key auth channel into a sanitized planner environment', async () => {
    const envFile = installAuthRecordingShim();
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-canary';
    process.env['OPENAI_API_KEY'] = 'openai-canary';

    const planner = await createTrustedClaudeCodePlanner({ authChannel: 'api-key' });
    await planner.review('prompt', projectDir, { onOutput: () => {} });

    expect(readFileSync(envFile, 'utf8').trim()).toBe('anthropic-canary|');
  });

  it('does not inherit ambient API keys for the session auth channel', async () => {
    const envFile = installAuthRecordingShim();
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-canary';
    process.env['OPENAI_API_KEY'] = 'openai-canary';

    const planner = await createTrustedClaudeCodePlanner({ authChannel: 'session' });
    await planner.review('prompt', projectDir, { onOutput: () => {} });

    expect(readFileSync(envFile, 'utf8').trim()).toBe('|');
  });

  it('suppresses expired-session resume attempt events when fallback succeeds', async () => {
    const tasksMarkdown = `---
id: T001
title: Claude fallback task
action: create
file: src/claude-fallback.ts
depends_on: []
---

### Description
Create the Claude fallback file.

### Tests
- fallback attempt succeeds
`;
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'if printf \'%s\\n\' "$@" | grep -q "^--session-id$"; then',
        `  printf '%s\\n' '${JSON.stringify({ type: 'result', is_error: true, session_id: 'sess-old', result: 'session not found: sess-old', usage: { input_tokens: 1, output_tokens: 1 } }).replace(/'/g, "'\\''")}'`,
        '  exit 0',
        'fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-new', result: tasksMarkdown, usage: { input_tokens: 2, output_tokens: 2 } }).replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const events: Array<{ type: string; callId: string; attempt?: number | undefined }> = [];
    const reportedSessionIds: string[] = [];
    const planner = await createTrustedClaudeCodePlanner({
      authChannel: 'session',
      initialSessionId: 'sess-old',
    });

    const result = await planner.quickPlan({
      feature: 'fallback',
      projectDir,
      callbacks: {
        onOutput: () => {},
        onSessionId: (sessionId) => reportedSessionIds.push(sessionId),
        onCallEvent: (event) => {
          if (event.type === 'call_started' || event.type === 'call_error') events.push(event);
        },
      },
    });

    expect(result.tasks).toHaveLength(1);
    const started = events.filter((event) => event.type === 'call_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ attempt: 2 });
    expect(started[0]?.callId).toMatch(/-attempt-2$/);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'call_error' }));
    expect(JSON.stringify(events)).not.toContain('sess-old');
    expect(reportedSessionIds).toEqual(['sess-new']);
  });

  it('treats a different returned Claude session id as expired resume and does not expose it', async () => {
    const tasksMarkdown = `---
id: T001
title: Claude mismatch fallback task
action: create
file: src/claude-mismatch.ts
depends_on: []
---

### Description
Create the Claude mismatch fallback file.

### Tests
- fallback attempt succeeds
`;
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'if printf \'%s\\n\' "$@" | grep -q "^--session-id$"; then',
        `  printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-new-unexpected', result: 'stale resumed output', usage: { input_tokens: 1, output_tokens: 1 } }).replace(/'/g, "'\\''")}'`,
        '  exit 0',
        'fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-fresh', result: tasksMarkdown, usage: { input_tokens: 2, output_tokens: 2 } }).replace(/'/g, "'\\''")}'`,
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
      authChannel: 'session',
      initialSessionId: 'sess-old',
    });

    const result = await planner.quickPlan({
      feature: 'fallback',
      projectDir,
      callbacks: {
        onOutput: (chunk) => output.push(chunk),
        onSessionId: (sessionId) => reportedSessionIds.push(sessionId),
        onSessionExpired: (sessionId) => expiredSessionIds.push(sessionId),
        onCallEvent: (event) => events.push(event),
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(expiredSessionIds).toEqual(['sess-old']);
    expect(reportedSessionIds).toEqual(['sess-fresh']);
    expect(output.join('\n')).not.toContain('stale resumed output');

    const started = events.filter((event) => event.type === 'call_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ attempt: 2 });
    const sessionEvents = events.filter((event) => event.type === 'call_session_id');
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]).toMatchObject({ nativeSessionId: 'sess-fresh' });
    expect(JSON.stringify(events)).not.toContain('sess-new-unexpected');
  });

  it('suppresses native injection events when Claude returns a different session id', async () => {
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-new-unexpected', result: 'stale injected output', usage: { input_tokens: 2, output_tokens: 2 } }).replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const events: RunnerCallEvent[] = [];
    const planner = await createTrustedClaudeCodePlanner({
      authChannel: 'session',
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
      authChannel: 'session',
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
});
