import { chmodSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationCallEnvelope,
} from '../../../core/schemas/task-compilation.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import { runClaudeOneShot } from './invoke.js';
import type { RunnerCallEvent } from '../../calls/types.js';

let shimDir: string;
let projectDir: string;
let restorePath: () => void;

beforeEach(() => {
  shimDir = createTempDir('claude-error-redaction-shim');
  projectDir = createTempDir('claude-error-redaction-project');
  restorePath = prependPath(shimDir);
});

afterEach(() => {
  restorePath();
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

function installFailingClaudeShim(): CliExecutableIdentity {
  const shimPath = join(shimDir, 'claude');
  const script = [
    '#!/usr/bin/env node',
    "process.stderr.write('failure from ' + process.argv[1] + '\\n');",
    'process.exit(23);',
    '',
  ].join('\n');
  writeFileSync(shimPath, script, 'utf8');
  chmodSync(shimPath, 0o755);
  const path = realpathSync(shimPath);
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

describe('Claude invoke process diagnostics', () => {
  it('redacts a trusted executable path from nonzero exit errors and call events', async () => {
    const executable = installFailingClaudeShim();
    const events: RunnerCallEvent[] = [];

    const caught = await runClaudeOneShot({
      prompt: 'prompt',
      projectDir,
      executable,
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    }).catch((err: unknown) => err);

    expect(caught).toMatchObject({
      kind: 'process-output',
      message: 'claude exited with code 23: failure from claude',
    });
    const data = JSON.stringify((caught as { data?: unknown }).data);
    expect(data).toContain('claude');
    expect(data).not.toContain(executable.path);

    expect(JSON.stringify(events)).not.toContain(executable.path);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'call_error',
          error: expect.objectContaining({
            code: 'process-output',
            message: 'claude exited with code 23: failure from claude',
          }),
        }),
      ]),
    );
  });

  it('redacts credentials from compiler-enveloped one-shot failure events', async () => {
    const credential = 'opaque-claude-envelope-one-shot-canary-51e7b3d0';
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      `#!/usr/bin/env node\nprocess.stderr.write('quota exceeded: ${credential}\\n');process.exit(23);\n`,
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const path = realpathSync(shimPath);
    const info = statSync(path);
    const executable: CliExecutableIdentity = {
      path,
      fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
    };
    const events: RunnerCallEvent[] = [];
    const envelope: TaskCompilationCallEnvelope = {
      version: 1,
      promptBytes: 512,
      inputTokensUpperBound: 512,
      requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
      outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
      maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
      maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
      maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
      maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
      deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
      idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    };

    await expect(
      runClaudeOneShot({
        prompt: 'prompt',
        projectDir,
        executable,
        envelope,
        authChannel: 'api-key',
        env: { PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: credential },
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: 'claude exited with code 23: quota exceeded: ***REDACTED***',
    });

    const persisted = JSON.stringify(events);
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
  });
});
