import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import { PLANNER_ARTIFACT_MAX_BYTES } from '../../engine/runners/types.js';
import { matches } from '../../utils/error.js';
import { RPC_MAX_FRAME_BYTES } from './types.js';
import { runRpc } from './run/host.js';

const isRpcShuttingDown = matches('rpc-shutting-down');

let dirs: string[] = [];

function writeConfig(projectDir: string, mode = 'standard'): void {
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
      `  mode: ${mode}`,
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

  it('replays exact artifact approval text through RPC status without a pathname', async () => {
    const projectDir = createTempDir('rpc-run-artifact-approval');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    let approvalResult: unknown;
    const sentinel = 'artifact-rpc-transient-28017';
    const artifactText = `${'\u0000'.repeat(
      PLANNER_ARTIFACT_MAX_BYTES - Buffer.byteLength(sentinel, 'utf8'),
    )}${sentinel}`;
    const review = Object.freeze({ label: 'Custom planner artifact', text: artifactText });
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      approvalResult = await workflowOpts.callbacks.onApprovalNeeded('artifact', review);
    };

    const run = runRpc({
      feature: 'artifact approval test',
      projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-artifact-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      const response = chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.type === 'status' && entry.data?.approvalType === 'artifact');
      expect(response).toMatchObject({
        data: {
          pending: 'approval',
          approvalType: 'artifact',
          review,
          allowedCommands: [],
        },
      });
    });

    input.write('{"type":"status"}\n');
    await vi.waitFor(() => {
      const lines = chunks.join('').split('\n').filter(Boolean);
      const artifactLines = lines.filter((line) => {
        const response = JSON.parse(line);
        return response.type === 'status' && response.data?.approvalType === 'artifact';
      });
      expect(artifactLines).toHaveLength(2);
      for (const line of artifactLines) {
        const response = JSON.parse(line);
        expect(response.data).toMatchObject({
          pending: 'approval',
          approvalType: 'artifact',
          review,
          allowedCommands: [],
        });
        expect(response.data).not.toHaveProperty('filePath');
        expect(Buffer.byteLength(`${line}\n`, 'utf8')).toBeLessThanOrEqual(RPC_MAX_FRAME_BYTES);
      }
    });

    input.write('{"type":"approve"}\n');
    await run;

    expect(approvalResult).toEqual({ approved: true });
    const responses = chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(
      JSON.stringify(responses.filter((response) => response.type !== 'status')),
    ).not.toContain(sentinel);
    expect(chunks.join('')).toContain('"command":"approve"');
  });

  it('returns an RPC error instead of acknowledging a slash edit after the config changes', async () => {
    const projectDir = createTempDir('rpc-run-config-conflict');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    let workflowStarted = false;
    let completeWorkflow = () => {};
    const workflowCompletion = new Promise<void>((resolve) => {
      completeWorkflow = resolve;
    });
    const runWorkflowStub = async () => {
      workflowStarted = true;
      await workflowCompletion;
    };

    const run = runRpc({
      feature: 'config-conflict test',
      projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-config-conflict-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      expect(workflowStarted).toBe(true);
    });
    writeConfig(projectDir, 'quick');
    const externalBytes = readFileSync(join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8');
    input.write('{"type":"slash","command":"/mode speckit"}\n');

    await vi.waitFor(() => {
      expect(chunks.join('')).toContain('Reload configuration before retrying.');
    });
    const responses = chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(responses).not.toContainEqual(
      expect.objectContaining({ type: 'ack', command: 'slash' }),
    );
    expect(readFileSync(join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8')).toBe(externalBytes);

    completeWorkflow();
    await run;
  });
});
