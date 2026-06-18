import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeCodePlanner } from './claude-code.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

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
  it('uses distinct runner call ids for expired-session resume fallback attempts', async () => {
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
    const planner = createClaudeCodePlanner({ initialSessionId: 'sess-old' });

    const result = await planner.quickPlan({
      feature: 'fallback',
      projectDir: shimDir,
      callbacks: {
        onOutput: () => {},
        onCallEvent: (event) => {
          if (event.type === 'call_started' || event.type === 'call_error') events.push(event);
        },
      },
    });

    expect(result.tasks).toHaveLength(1);
    const started = events.filter((event) => event.type === 'call_started');
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ attempt: 1 });
    expect(started[1]).toMatchObject({ attempt: 2 });
    expect(started[0]?.callId).toMatch(/-attempt-1$/);
    expect(started[1]?.callId).toMatch(/-attempt-2$/);
    expect(started[0]?.callId).not.toBe(started[1]?.callId);
  });
});
