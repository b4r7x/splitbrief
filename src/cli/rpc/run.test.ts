import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import { matches } from '../../utils/error.js';
import { runRpc } from './run/host.js';

const isRpcShuttingDown = matches('rpc-shutting-down');

let dirs: string[] = [];

function writeConfig(projectDir: string): void {
  const splitbriefDir = join(projectDir, SPLITBRIEF_DIR);
  mkdirSync(splitbriefDir, { recursive: true });
  const configPath = join(splitbriefDir, CONFIG_FILE);
  writeFileSync(
    configPath,
    [
      'version: 3',
      'planner:',
      '  kind: cli',
      '  tool: claude-code',
      'implementer:',
      '  kind: api',
      '  provider: ollama',
      '  api_base: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
      'validation:',
      '  typecheck: false',
      '  lint: false',
      '  test: false',
      '  test_command: "noop"',
      'workflow:',
      '  approve: default',
      '  max_retries: 3',
      '  commit_strategy: none',
      '  mode: standard',
    ].join('\n'),
  );
  chmodSync(configPath, 0o600);
}

describe('runRpc', () => {
  afterEach(() => {
    for (const dir of dirs) cleanupTempDir(dir);
    dirs = [];
  });

  it('rejects a pending approval gate when stdin closes unexpectedly', async () => {
    const projectDir = createTempDir('rpc-run-gate-close');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      await workflowOpts.callbacks.onApprovalNeeded('spec', join(projectDir, 'spec.md'));
    };

    const run = runRpc({
      feature: 'gate-close test',
      projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-gate-close-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      expect(input.readable).toBe(true);
    });

    input.end();
    await expect(run).rejects.toSatisfy((err: unknown) => {
      if (!isRpcShuttingDown(err)) return false;
      expect(err.kind).toBe('rpc-shutting-down');
      expect(err.message).toBe('stdin closed unexpectedly');
      expect(err.data).toEqual({ reason: 'stdin closed unexpectedly' });
      return true;
    });
  });
});
