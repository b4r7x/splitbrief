import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import { SANDBOX_DIR, TASKS_FILE } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
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
    const home = isolateHome();
    mkdirSync(join(home.dir, '.claude'), { recursive: true });
    writeFileSync(join(home.dir, '.claude', '.credentials.json'), '{"session":"stub"}\n', 'utf8');

    try {
      const planner = await createTrustedClaudeCodePlanner({ authChannel: undefined });
      await planner.review('prompt', projectDir, { onOutput: () => {} });

      expect(readFileSync(envFile, 'utf8').trim()).toBe('|');
      const staged = join(
        projectDir,
        SANDBOX_DIR,
        'planner',
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
        'if printf \'%s\\n\' "$@" | grep -q "^--resume$"; then',
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
        'if printf \'%s\\n\' "$@" | grep -q "^--resume$"; then',
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

  it('reads phase artifacts from the terminal result only and ignores seeded session tasks.md', async () => {
    const terminalMarkdown = `# Task Briefs: titleCase function

---
id: T001
title: Create titleCase function in src/text.ts
action: create
file: src/text.ts
depends_on: []
---

### Description
Create a new file \`src/text.ts\` exporting a \`titleCase\` function.

### Tests
- \`titleCase('hello world')\` → \`'Hello World'\`

---
id: T002
title: Add vitest tests for titleCase in src/text.test.ts
action: create
file: src/text.test.ts
depends_on: [T001]
---

### Description
Create \`src/text.test.ts\` with vitest tests for \`titleCase\`.

### Tests
- \`expect(titleCase('hello world')).toBe('Hello World')\`
`;
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `cat <<'JSON_EOF'`,
        JSON.stringify({
          type: 'result',
          session_id: '0a3443ac-432e-40c8-bdf9-29859130257f',
          result: terminalMarkdown,
          usage: { input_tokens: 6, output_tokens: 3006 },
        }),
        'JSON_EOF',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const warnings: string[] = [];
    const sessionId = '2026-08-06-add-a-titlecase-function-to-src-text-ts-that-capit';
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, terminalMarkdown);

    const planner = await createTrustedClaudeCodePlanner({ authChannel: 'session' });

    const result = await planner.quickPlan({
      feature: 'add a titleCase function to src/text.ts',
      projectDir,
      callbacks: {
        onOutput: () => {},
        onWarning: (message) => warnings.push(message),
        sessionId,
      },
    });

    expect(warnings).toEqual([]);
    expect(result.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
    expect(result.phases?.[0]?.artifact.text).toContain('id: T001');
    expect(result.phases?.[0]?.rawOutput).toBeUndefined();
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
        `printf '%s ' "$@" >> '${argvLog}'`,
        `printf '\\n' >> '${argvLog}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'result', session_id: 'sess-1', result: tasksMarkdown, usage: { input_tokens: 1, output_tokens: 1 } }).replace(/'/g, "'\\''")}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;

    const planner = await createTrustedClaudeCodePlanner({ authChannel: 'session' });
    const first = await planner.quickPlan({
      feature: 'first call',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    const second = await planner.quickPlan({
      feature: 'retry call',
      projectDir,
      callbacks: { onOutput: () => {} },
    });

    expect(first.tasks).toHaveLength(1);
    expect(second.tasks).toHaveLength(1);

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

    const planner = await createTrustedClaudeCodePlanner({ authChannel: 'session' });
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

    const planner = await createTrustedClaudeCodePlanner({ authChannel: 'session' });
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
        authChannel: 'session',
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
        authChannel: 'session',
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
