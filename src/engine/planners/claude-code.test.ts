import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeCodePlanner } from './claude-code.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { writeCommandShim } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallEvent } from '../calls/types.js';

/**
 * Exercises the real subprocess seam. `claude-code.ts` escalation calls
 * `runClaudeOneShot`, which hardcodes `command: 'claude'`. We install a shim
 * named `claude` whose discovery depends entirely on the PATH the planner hands
 * the subprocess: when escalation forwards `sandboxEnv` as the spawn `env`, that
 * replaces the whole process environment, so the shim is only found via the
 * PATH inside `sandboxEnv`. The shim records the marker env var it observed,
 * letting us assert that `sandboxEnv` actually reached the spawned process.
 */

let shimDir: string;
let originalPath: string | undefined;

function installRecordingShim(): { envMarkerFile: string } {
  const envMarkerFile = join(shimDir, 'env-marker.txt');
  const shimPath = join(shimDir, 'claude');
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "$DIPTYCH_SANDBOX_MARKER" > '${envMarkerFile}'`,
    `printf '%s\\n' '{"type":"result","result":"\`\`\`ts\\nexport const x = 1;\\n\`\`\`"}'`,
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return { envMarkerFile };
}

beforeEach(() => {
  shimDir = createTempDir('claude-code-planner-shim');
  originalPath = process.env['PATH'];
});

afterEach(() => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  cleanupTempDir(shimDir);
});

describe('createClaudeCodePlanner escalation', () => {
  it('forwards sandboxEnv to the spawned claude subprocess during escalateFull', async () => {
    const { envMarkerFile } = installRecordingShim();
    // Strip the shim dir from the ambient PATH so the only way `claude` is found
    // is through the PATH carried inside sandboxEnv — proving forwarding.
    process.env['PATH'] = '/nonexistent-empty-path-for-claude-code-test';

    const planner = createClaudeCodePlanner({});

    await planner.escalateFull({
      task: makeTask(),
      error: 'boom',
      projectDir: shimDir,
      callbacks: { onOutput: () => {} },
      sandboxEnv: {
        PATH: `${shimDir}:${originalPath ?? ''}`,
        DIPTYCH_SANDBOX_MARKER: 'forwarded',
      },
    });

    expect(existsSync(envMarkerFile)).toBe(true);
    expect(readFileSync(envMarkerFile, 'utf8').trim()).toBe('forwarded');
  });
});

describe('createClaudeCodePlanner planning', () => {
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
    const onSessionId = vi.fn();
    const planner = createClaudeCodePlanner({ initialSessionId: 'sess-old' });

    const result = await planner.quickPlan({
      feature: 'fallback',
      projectDir: shimDir,
      callbacks: {
        onOutput: () => {},
        onSessionId,
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
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onSessionId).toHaveBeenCalledWith('sess-new');
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
    const onSessionId = vi.fn();
    const onSessionExpired = vi.fn();
    const onOutput = vi.fn();
    const planner = createClaudeCodePlanner({ initialSessionId: 'sess-old' });

    const result = await planner.quickPlan({
      feature: 'fallback',
      projectDir: shimDir,
      callbacks: {
        onOutput,
        onSessionId,
        onSessionExpired,
        onCallEvent: (event) => events.push(event),
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(onSessionExpired).toHaveBeenCalledWith('sess-old');
    expect(onSessionId).not.toHaveBeenCalledWith('sess-new-unexpected');
    expect(onSessionId).toHaveBeenCalledWith('sess-fresh');
    expect(JSON.stringify(onOutput.mock.calls)).not.toContain('stale resumed output');

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
    const planner = createClaudeCodePlanner({ initialSessionId: 'sess-old' });

    await expect(
      planner.injectUserTurn?.({
        text: 'continue',
        projectDir: shimDir,
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
    const planner = createClaudeCodePlanner({ idleWarnMs: 30 });

    const result = await planner.review('prompt', shimDir, {
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result.text).toContain('slow response');
    const stalled = events.find((event) => event.type === 'call_stalled');
    expect(stalled).toMatchObject({ type: 'call_stalled', silentMs: expect.any(Number) });
  });
});
