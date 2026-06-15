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
