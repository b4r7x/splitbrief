import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CliExecutableReceiptSchema,
  formatDigestBoundExecutableFingerprint,
  type CliExecutableReceipt,
} from '../../../src/core/discovery/detection.js';
import type { Config } from '../../../src/core/schemas/config.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationOperationIdSchema,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
  type TaskCompilationProgram,
  type PlannerSessionScope,
  type PlannerArtifactTransport,
} from '../../../src/core/schemas/task-compilation.js';
import type { DispatchClaim } from '../../../src/engine/calls/dispatch-ledger.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
  type TaskDispatchLedger,
} from '../../../src/engine/calls/dispatch-ledger.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallResult,
} from '../../../src/engine/calls/types.js';
import type { PlannerCallbacks, PlannerInvokeResult } from '../../../src/engine/planners/types.js';
import { runMultiPhasePlanning } from '../../../src/engine/planners/multi-phase.js';
import {
  compileTaskBriefs,
  materializeTaskCompilationProgram,
} from '../../../src/engine/spec/tasks/compiler.js';
import type { TaskCompilerBatchDispatch } from '../../../src/engine/spec/tasks/compiler.js';
import { createPlanner } from '../../../src/engine/runners/factory.js';
import {
  invokeCliAdapter,
  toCliEnvironment,
} from '../../../src/engine/runners/invoke-cli-adapter.js';
import { opencodePlannerAdapter } from '../../../src/engine/runners/cli-tools/opencode.js';
import { CLI_PROMPT_SENTINEL } from '../../../src/engine/runners/cli-tools/candidate-contract.js';
import { resolveCliExecutableAliases } from '../../../src/engine/runners/resolve-cli-executable.js';
import { assertCliStartGate, type CliStartGate } from '../../../src/engine/runners/start-gate.js';
import { createRunnerSandboxEnv } from '../../../src/engine/runners/sandbox-env.js';
import type { RunnerGate } from '../../../src/engine/runners/prepared-execution.js';
import type { PreparedPlannerInvocation } from '../../../src/engine/runners/types.js';
import { killAllProcesses } from '../../../src/lib/process/registry.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const OPERATION_ID = TaskCompilationOperationIdSchema.parse('operation-compiler-matrix');

const SPEC = '# Spec\n\nRequirements.';
const RESEARCH = '# Research\n\n**Language**: TypeScript\n\nFindings.';
const SENTINEL_A = 'final-sentinel-\u03b1\u03b2-\u2713-\ud83d\ude80-first';
const SENTINEL_B = 'final-sentinel-\u03b1\u03b2-\u2713-\ud83d\ude80-second';

function planWithFiles(count: number): string {
  const newFiles = Array.from(
    { length: count },
    (_, index) =>
      `- \`src/generated/file-${index + 1}.ts\`\n  Purpose: implement file ${index + 1}.`,
  ).join('\n');
  return `# Plan\n\n## File Structure\n### New Files\n${newFiles}\n\n### Modified Files\n\n## Dependencies\nNone.`;
}

function envelopeFixture(
  overrides: Readonly<Partial<TaskCompilationCallEnvelope>> = {},
): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes: TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
    inputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
    requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
    idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    ...overrides,
  };
}

function invocationFixture(
  envelope: TaskCompilationCallEnvelope = envelopeFixture(),
  transport: PlannerArtifactTransport = { kind: 'stdout-final' },
): PreparedPlannerInvocation {
  return {
    runtime: {
      executablePath: '/usr/bin/fake-compiler',
      version: 'fixture-1.0.0',
      runtimeDigest: 'runtime-fixture-digest',
      protocolDigest: 'protocol-fixture-digest',
    },
    role: 'planner-read-only',
    transport,
    terminalContract: 'opencode-final-message-v1',
    envelope,
    capabilityDigest: 'capability-fixture-digest',
  };
}

const SHIM_SOURCE = [
  '#!/usr/bin/env node',
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const capture = __CAPTURE__;',
  'const args = process.argv.slice(2);',
  "if (args.indexOf('--version') !== -1) { process.stdout.write('1.18.15\\n'); process.exit(0); }",
  "if (args[0] === 'auth') process.exit(0);",
  "const prompt = args[args.length - 1] ?? '';",
  'fs.mkdirSync(capture, { recursive: true });',
  "const counterPath = path.join(capture, 'counter');",
  'let n = 0;',
  "try { n = Number.parseInt(fs.readFileSync(counterPath, 'utf8'), 10) || 0; } catch (err) {}",
  'n += 1;',
  'fs.writeFileSync(counterPath, String(n));',
  "let mode = 'batch';",
  'try {',
  "  const modes = fs.readFileSync(path.join(capture, 'modes.txt'), 'utf8').split('\\n');",
  "  mode = (modes[n - 1] ?? '').trim() || 'batch';",
  '} catch (err) {}',
  'let failAt = 0;',
  "try { failAt = Number.parseInt(fs.readFileSync(path.join(capture, 'fail-at'), 'utf8'), 10) || 0; } catch (err) {}",
  'const items = [];',
  '{',
  "  const lines = prompt.split('\\n');",
  '  for (let i = 0; i < lines.length - 1; i += 1) {',
  "    const line = lines[i] ?? '';",
  "    const next = lines[i + 1] ?? '';",
  '    if (!/^\\s+Purpose:/.test(next)) continue;',
  "    const start = line.indexOf('`');",
  '    if (start < 0) continue;',
  "    const end = line.indexOf('`', start + 1);",
  '    if (end < 0) continue;',
  '    const id = line.slice(start + 1, end);',
  '    if (!/^[A-Za-z0-9]+$/.test(id)) continue;',
  "    const close = line.lastIndexOf('`');",
  '    if (close <= end) continue;',
  "    const open = line.lastIndexOf('`', close - 1);",
  '    if (open <= end) continue;',
  '    const action = /(create|modify)/.exec(line);',
  "    items.push({ id, action: action ? action[1] : 'create', file: line.slice(open + 1, close) });",
  '  }',
  '}',
  'const marker = [',
  "  'n=' + n,",
  "  'mode=' + mode,",
  "  'pid=' + process.pid,",
  "  'cwd=' + process.cwd(),",
  "  'home=' + (process.env.HOME ?? ''),",
  "  'tmpdir=' + (process.env.TMPDIR ?? ''),",
  "  'xdg_config_home=' + (process.env.XDG_CONFIG_HOME ?? ''),",
  "  'argv=' + args.join(' '),",
  "  'prompt_bytes=' + Buffer.byteLength(prompt, 'utf8'),",
  "  'items=' + items.map((item) => item.id).join(','),",
  "].join('\\n');",
  "fs.writeFileSync(path.join(capture, 'spawn-' + n + '.txt'), marker + '\\n');",
  'const emit = (text) => {',
  "  process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text } }) + '\\n');",
  '};',
  'const blockFor = (item) => [',
  "  '---',",
  "  'id: ' + item.id,",
  "  'title: \"Task ' + item.id + '\"',",
  "  'action: ' + item.action,",
  "  'file: ' + item.file,",
  "  'depends_on: []',",
  "  '---',",
  "  '',",
  "  '### Description',",
  "  'Implement ' + item.file + '.',",
  "  '',",
  "  '### Tests',",
  "  '- ' + item.id + ' works',",
  "  '',",
  "  '### Constraints',",
  "  '- none',",
  "  '',",
  "].join('\\n');",
  'const emitItems = (list) => {',
  '  for (const item of list) emit(blockFor(item));',
  '};',
  'const stepFinish = () => {',
  "  process.stdout.write(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 11, output: 22 } } }) + '\\n');",
  '};',
  'const bodies = {',
  '  batch() {',
  '    if (failAt > 0 && n === failAt) {',
  "      process.stderr.write('fixture stderr\\n');",
  '      process.exit(17);',
  '    }',
  '    emitItems(items);',
  '    stepFinish();',
  '  },',
  "  'partial-batch'() {",
  '    emitItems(items.slice(0, 1));',
  '    stepFinish();',
  '  },',
  "  'error-terminal'() {",
  '    emitItems(items);',
  "    process.stdout.write(JSON.stringify({ type: 'error', message: 'quota exceeded' }) + '\\n');",
  '  },',
  '  research() {',
  '    emit(__RESEARCH__);',
  '  },',
  '  spec() {',
  '    emit(__SPEC__);',
  '  },',
  '  plan() {',
  '    emit(__PLAN__);',
  '  },',
  '  final() {',
  "    emit(prompt.indexOf('first') !== -1 ? __SENTINEL_A__ : __SENTINEL_B__);",
  '  },',
  '  hang() {',
  "    const { spawn } = require('node:child_process');",
  "    const child = spawn('sleep', ['60'], { stdio: 'ignore' });",
  "    fs.appendFileSync(path.join(capture, 'spawn-' + n + '.txt'), 'descendant=' + child.pid + '\\n');",
  '    setInterval(() => {}, 1000);',
  '  },',
  "  'flood-text'() {",
  '    process.stdout.write(\'{"type":"text","part":{"type":"text","text":"\' + \'x\'.repeat(102400) + \'"}}\\n\');',
  '  },',
  "  'flood-raw'() {",
  '    for (let i = 0; i < 100; i += 1) {',
  "      const record = { type: 'tool_use', part: { tool: 'read', id: 'read_' + i, name: 'read', state: { status: 'completed', input: { file: 'x' }, output: 'y'.repeat(2048) } } };",
  "      process.stdout.write(JSON.stringify(record) + '\\n');",
  '    }',
  '  },',
  '};',
  'const body = bodies[mode] ?? null;',
  'if (body === null) {',
  "  process.stderr.write('unknown mode: ' + mode + '\\n');",
  '  process.exit(2);',
  '}',
  'body();',
].join('\n');

function writeOpencodeShim(opts: { dir: string; capture: string }): string {
  const source = SHIM_SOURCE.replaceAll('__CAPTURE__', JSON.stringify(opts.capture))
    .replaceAll('__RESEARCH__', JSON.stringify(RESEARCH))
    .replaceAll('__SPEC__', JSON.stringify(SPEC))
    .replaceAll('__PLAN__', JSON.stringify(planWithFiles(8)))
    .replaceAll('__SENTINEL_A__', JSON.stringify(SENTINEL_A))
    .replaceAll('__SENTINEL_B__', JSON.stringify(SENTINEL_B));
  const shimPath = join(opts.dir, 'opencode');
  writeFileSync(shimPath, source, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

async function shimReceipt(path: string): Promise<CliExecutableReceipt> {
  const realPath = await realpath(path);
  const canonicalPath = path;
  const info = await stat(realPath);
  const fingerprint = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
  const contentDigest = createHash('sha256')
    .update(await readFile(realPath))
    .digest('hex');
  const digestFingerprint = formatDigestBoundExecutableFingerprint({
    fingerprint,
    contentDigest,
  });
  if (digestFingerprint === null) throw new Error('shim fingerprint failed');
  return CliExecutableReceiptSchema.parse({
    path: realPath,
    fingerprint,
    executableIdentity: {
      canonicalPath,
      realPath,
      platformFileId: `${info.dev}:${info.ino}`,
      fingerprint: digestFingerprint,
      resolvedAt: Date.now(),
    },
  });
}

type MatrixHarness = Readonly<{
  root: string;
  projectDir: string;
  binDir: string;
  capture: string;
  config: Config;
  receipt: CliExecutableReceipt;
  trustedCli: CliStartGate;
}>;

async function createMatrixHarness(): Promise<MatrixHarness> {
  const root = createTempDir('compiler-matrix-root');
  const projectDir = join(root, 'project');
  const binDir = join(root, 'bin');
  const capture = join(root, 'capture');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(capture, { recursive: true });
  createTestGitRepo(projectDir);
  const config = makeConfig({ planner: { kind: 'cli', tool: 'opencode' } });
  const shimPath = writeOpencodeShim({ dir: binDir, capture });
  const receipt = await shimReceipt(shimPath);
  return {
    root,
    projectDir,
    binDir,
    capture,
    config,
    receipt,
    trustedCli: { tool: 'opencode', executable: receipt },
  };
}

let harness: MatrixHarness | null = null;
let hostHome: string | null = null;

beforeEach(async () => {
  harness = await createMatrixHarness();
  hostHome = createTempDir('compiler-matrix-host-home');
  vi.stubEnv('PATH', `${harness.binDir}${delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('HOME', hostHome);
  vi.stubEnv('XDG_CONFIG_HOME', createTempDir('compiler-matrix-host-xdg'));
});

afterEach(async () => {
  await killAllProcesses();
  vi.unstubAllEnvs();
  if (harness !== null) cleanupTempDir(harness.root);
  if (hostHome !== null) cleanupTempDir(hostHome);
  harness = null;
  hostHome = null;
});

function currentHarness(): MatrixHarness {
  if (harness === null) throw new Error('harness is not initialized');
  return harness;
}

function setModes(modes: readonly string[]): void {
  const h = currentHarness();
  writeFileSync(join(h.capture, 'modes.txt'), `${modes.join('\n')}\n`, 'utf8');
}

function markerCount(): number {
  const h = currentHarness();
  return readdirSync(h.capture).filter((name) => /^spawn-\d+\.txt$/.test(name)).length;
}

function readMarker(n: number): Record<string, string> {
  const h = currentHarness();
  const content = readFileSync(join(h.capture, `spawn-${n}.txt`), 'utf8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function refusedBatchResult(
  attemptId: TaskCompilationAttemptId,
  claim: Extract<DispatchClaim, { kind: 'refused' }>,
): PlannerInvokeResult {
  return {
    callId: attemptId,
    attemptId,
    role: 'planner',
    backendKind: 'cli',
    status: 'refused',
    terminalStatus: 'refused',
    failureCode: 'task_compiler_dispatch_limit',
    error: {
      code: 'task_compiler_dispatch_limit',
      message: `The task dispatch ceiling is refused (${claim.dispatchCount}/${claim.dispatchLimit}).`,
    },
    partial: false,
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    text: '',
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
  };
}

type DetachedScope = Extract<PlannerSessionScope, { kind: 'detached-fresh' }>;

async function spawnBatch(opts: {
  h: MatrixHarness;
  prompt: string;
  callContext: RunnerCallContext;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}): Promise<RunnerCallResult> {
  const { h, prompt, callContext, onCallEvent } = opts;
  const resolved = await resolveCliExecutableAliases({
    commands: ['opencode'],
    projectDir: h.projectDir,
    trust: assertCliStartGate('opencode', h.trustedCli),
  });
  const baseArgs = opencodePlannerAdapter.baseArgs({
    prompt: CLI_PROMPT_SENTINEL,
    model: undefined,
    projectDir: h.projectDir,
    configuredArgs: [],
    mode: 'plan',
    sessionId: null,
    effort: undefined,
  });
  const environment = await createRunnerSandboxEnv(h.projectDir, h.config.planner, 'planner');
  return invokeCliAdapter({
    adapter: opencodePlannerAdapter,
    invocation: {
      executable: resolved.executable,
      args: [...baseArgs],
      baseArgs,
      promptTransport: opencodePlannerAdapter.promptTransport,
      environment: toCliEnvironment(environment),
      cwd: h.projectDir,
      timeoutMs: callContext.envelope?.deadlineMs ?? TASK_BRIEF_COMPILER_POLICY.deadlineMs,
      signal: undefined,
    },
    prompt,
    callContext,
    onCallEvent,
  });
}

type CompileRun = Readonly<{
  candidate: Awaited<ReturnType<typeof compileTaskBriefs>> | null;
  failure: unknown;
  program: TaskCompilationProgram | null;
  ledger: TaskDispatchLedger | null;
  events: readonly RunnerCallEvent[];
  scopes: readonly DetachedScope[];
}>;

function runCompile(opts: {
  count: number;
  modes?: readonly string[] | undefined;
  failAt?: number | undefined;
  envelope?: TaskCompilationCallEnvelope | undefined;
  plan?: string | undefined;
}): Promise<CompileRun> {
  const h = currentHarness();
  setModes(opts.modes ?? ['batch']);
  if (opts.failAt !== undefined) {
    writeFileSync(join(h.capture, 'fail-at'), String(opts.failAt), 'utf8');
  }
  const envelope = opts.envelope ?? envelopeFixture();
  const input = {
    spec: SPEC,
    plan: opts.plan ?? planWithFiles(opts.count),
    languageContext: 'TypeScript',
  };
  const events: RunnerCallEvent[] = [];
  const scopes: DetachedScope[] = [];
  return (async () => {
    let candidate: Awaited<ReturnType<typeof compileTaskBriefs>> | null = null;
    let failure: unknown = null;
    let program: TaskCompilationProgram | null = null;
    let ledger: TaskDispatchLedger | null = null;
    try {
      program = materializeTaskCompilationProgram(input, { envelope });
      ledger = createTaskDispatchLedger({
        operation: program.operationEnvelope,
        operationId: OPERATION_ID,
        claimPort: createTaskDispatchClaimPort(),
      });
      const dispatch: TaskCompilerBatchDispatch = async ({
        attemptId,
        batch,
        sessionScope,
        ledger: seamLedger,
      }) => {
        if (sessionScope.kind !== 'detached-fresh') {
          throw new Error(`compiler matrix dispatch received scope ${sessionScope.kind}`);
        }
        scopes.push(sessionScope);
        const claim = seamLedger.claimDispatch(attemptId);
        if (claim.kind === 'refused') return refusedBatchResult(attemptId, claim);
        return spawnBatch({
          h,
          prompt: batch.prompt,
          callContext: {
            callId: attemptId,
            attemptId,
            role: 'planner',
            backendKind: 'cli',
            runnerName: 'opencode',
            sessionScope,
            envelope: batch.envelope,
          },
          onCallEvent: (event) => events.push(event),
        });
      };
      candidate = await compileTaskBriefs({
        inputs: input,
        invocation: invocationFixture(envelope),
        ledger,
        dispatch,
      });
    } catch (err) {
      failure = err;
    }
    return { candidate, failure, program, ledger, events, scopes };
  })();
}

function expectFailure(run: CompileRun, kind: string): void {
  expect(run.candidate).toBeNull();
  expect(run.failure).toMatchObject({ kind });
}

function requireLedger(run: CompileRun): TaskDispatchLedger {
  if (run.ledger === null) throw new Error('expected a materialized ledger');
  return run.ledger;
}

describe('compiler dispatch matrix — production spawn path with a shim executable', () => {
  describe('size matrix (REQ-001, REQ-002)', () => {
    it.each([
      [1, 1],
      [4, 1],
      [5, 2],
      [256, 64],
    ] as const)(
      'a %i-item manifest dispatches exactly %i batches through the shim',
      async (count, batches) => {
        const run = await runCompile({ count });
        expect(run.failure).toBeNull();
        expect(run.candidate?.merge.tasks).toHaveLength(count);
        expect(markerCount()).toBe(batches);
        expect(requireLedger(run).snapshot().dispatchCount).toBe(batches);
        expect(run.scopes).toHaveLength(batches);
        expect(run.scopes.map((scope) => scope.batchId)).toEqual(
          run.candidate?.program.batches.map((batch) => batch.batchId),
        );
        for (const scope of run.scopes) {
          expect(scope.kind).toBe('detached-fresh');
          expect(scope.operationId).toBe(OPERATION_ID);
        }
      },
      90_000,
    );

    it('rejects 257 items with a typed capacity failure and zero spawns', async () => {
      const run = await runCompile({ count: 257 });
      expectFailure(run, 'task_compiler_capacity_exceeded');
      expect(markerCount()).toBe(0);
      expect(run.ledger?.snapshot().dispatchCount ?? 0).toBe(0);
    });
  });

  describe('failure at batch N (REQ-006, REQ-008, REQ-014)', () => {
    it('failure at batch 2 claims exactly 2 dispatches, spawns exactly 2 shims, and rejects with no partial candidate', async () => {
      const run = await runCompile({ count: 12, modes: ['batch', 'batch', 'batch'], failAt: 2 });
      expectFailure(run, 'task_compiler_provider_failed');
      expect(run.failure).toMatchObject({ data: { batchOrdinal: 1 } });
      expect(markerCount()).toBe(2);
      expect(requireLedger(run).snapshot().dispatchCount).toBe(2);
      expect(readMarker(2).mode).toBe('batch');
    });

    it('a terminal error record outranks valid-looking brief bytes', async () => {
      const run = await runCompile({ count: 4, modes: ['error-terminal'] });
      expectFailure(run, 'task_compiler_provider_failed');
      expect(markerCount()).toBe(1);
      expect(requireLedger(run).snapshot().dispatchCount).toBe(1);
    });

    it('a partial batch is rejected as a manifest mismatch with no continuation', async () => {
      const run = await runCompile({ count: 4, modes: ['partial-batch'] });
      expectFailure(run, 'task_compiler_manifest_mismatch');
      expect(markerCount()).toBe(1);
      expect(requireLedger(run).snapshot().dispatchCount).toBe(1);
    });
  });

  describe('continuation cannot reset the counter or replay batches (REQ-006, REQ-012)', () => {
    it('replaying a claimed attempt is refused, and a restored ledger cannot enlarge the counter', async () => {
      const run = await runCompile({ count: 12, modes: ['batch', 'batch', 'batch'], failAt: 2 });
      expectFailure(run, 'task_compiler_provider_failed');
      const ledger = requireLedger(run);
      const snapshot = ledger.snapshot();
      expect(snapshot.dispatchCount).toBe(2);
      const markersAfterFailure = markerCount();

      const replay = ledger.claimDispatch(snapshot.claimedAttemptIds[0] ?? '');
      expect(replay).toMatchObject({ kind: 'refused', reason: 'attempt-already-claimed' });
      expect(markerCount()).toBe(markersAfterFailure);

      const program = materializeTaskCompilationProgram(
        { spec: SPEC, plan: planWithFiles(12), languageContext: 'TypeScript' },
        { envelope: envelopeFixture() },
      );
      const restored = createTaskDispatchLedger({
        operation: program.operationEnvelope,
        operationId: OPERATION_ID,
        claimPort: createTaskDispatchClaimPort(),
        restore: snapshot,
      });
      expect(restored.snapshot().dispatchCount).toBe(2);
      expect(restored.claimDispatch(snapshot.claimedAttemptIds[1] ?? '')).toMatchObject({
        kind: 'refused',
        reason: 'attempt-already-claimed',
      });
      expect(restored.claimDispatch(snapshot.claimedAttemptIds[0] ?? '')).toMatchObject({
        kind: 'refused',
        reason: 'attempt-already-claimed',
      });
      expect(markerCount()).toBe(markersAfterFailure);
    });
  });

  describe('hard envelope at the real spawn (REQ-007, REQ-013)', () => {
    it('raw protocol overflow reaps the shim and stays terminally truncated', async () => {
      const run = await runCompile({
        count: 4,
        modes: ['flood-raw'],
        envelope: envelopeFixture({ maxRawProtocolBytes: 128 * 1024 }),
      });
      expectFailure(run, 'task_compiler_output_limited');
      expect(markerCount()).toBe(1);
      expect(requireLedger(run).snapshot().dispatchCount).toBe(1);
      expect(processIsAbsent(Number.parseInt(readMarker(1).pid ?? '', 10))).toBe(true);
    });

    it('normalized and artifact overflow is terminally truncated', async () => {
      const run = await runCompile({ count: 4, modes: ['flood-text'] });
      expectFailure(run, 'task_compiler_output_limited');
      expect(markerCount()).toBe(1);
      expect(requireLedger(run).snapshot().dispatchCount).toBe(1);
    });

    it('asserts the token bound on every batch call and refuses a hostile token or prompt bound before dispatch', async () => {
      const run = await runCompile({ count: 4, modes: ['batch'] });
      expect(run.failure).toBeNull();
      const started = run.events.filter((event) => event.type === 'call_started');
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        type: 'call_started',
        envelope: expect.objectContaining({
          requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
          maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
          maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
        }),
      });
      expect(run.events).toContainEqual(
        expect.objectContaining({
          type: 'call_usage',
          usage: { inputTokens: 11, outputTokens: 22 },
        }),
      );

      const hostileToken = runCompile({
        count: 4,
        envelope: envelopeFixture({
          outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes + 1,
        }),
      });
      const tokenRun = await hostileToken;
      expectFailure(tokenRun, 'task_compiler_protocol_invalid');
      expect(markerCount()).toBe(1);

      const hostilePrompt = runCompile({
        count: 4,
        envelope: envelopeFixture({ promptBytes: 100 }),
      });
      const promptRun = await hostilePrompt;
      expectFailure(promptRun, 'task_compiler_prompt_too_large');
      expect(markerCount()).toBe(1);
    });

    it('the deadline reaps the process tree and classifies the call as a timeout', async () => {
      // The deadline arms before the shim's own node boot, so it has to outlast
      // that boot or the tree is reaped before the child publishes its marker
      // and the reaping this test is about never gets to happen. The elapsed
      // bounds keep the constant load-bearing: a deadline that stops ending the
      // call fails them.
      const startedAt = Date.now();
      const run = await runCompile({
        count: 4,
        modes: ['hang'],
        envelope: envelopeFixture({ deadlineMs: 5_000 }),
      });
      const elapsedMs = Date.now() - startedAt;
      expectFailure(run, 'task_compiler_timeout');
      expect(elapsedMs).toBeGreaterThanOrEqual(5_000);
      expect(elapsedMs).toBeLessThan(20_000);
      expect(markerCount()).toBe(1);
      expect(requireLedger(run).snapshot().dispatchCount).toBe(1);
      const marker = readMarker(1);
      expect(processIsAbsent(Number.parseInt(marker.pid ?? '', 10))).toBe(true);
      const descendant = Number.parseInt(marker.descendant ?? '', 10);
      expect(descendant).toBeGreaterThan(1);
      expect(processIsAbsent(descendant)).toBe(true);
    }, 30_000);
  });

  describe('detached fresh scopes and workflow-session isolation (REQ-005)', () => {
    it('drives batch dispatch through the production spawn path with zero workflow-session contamination', async () => {
      const h = currentHarness();
      const count = 8;
      setModes(['research', 'spec', 'plan', 'batch', 'batch']);
      const envelope = envelopeFixture();
      const program = materializeTaskCompilationProgram(
        { spec: SPEC, plan: planWithFiles(count), languageContext: 'TypeScript' },
        { envelope },
      );
      const ledger = createTaskDispatchLedger({
        operation: program.operationEnvelope,
        operationId: OPERATION_ID,
        claimPort: createTaskDispatchClaimPort(),
      });
      const batchCallbacks: Array<{
        hasSessionId: boolean;
        onSessionId: string;
        onQuestion: string;
        onCallEvent: string;
      }> = [];
      const batchScopes: DetachedScope[] = [];
      const workflowCounts = { onSessionId: 0, onSessionExpired: 0, onQuestion: 0 };
      const callbacks: PlannerCallbacks = {
        onOutput: () => {},
        onPhase: () => {},
        onWarning: () => {},
        onQuestion: () => {
          workflowCounts.onQuestion += 1;
        },
        onSessionId: () => {
          workflowCounts.onSessionId += 1;
        },
        onSessionExpired: () => {
          workflowCounts.onSessionExpired += 1;
        },
        onCallEvent: () => {},
        sessionId: 'workflow-session-matrix',
      };
      const result = await runMultiPhasePlanning(
        {
          invokePlan: async (opts) => {
            const scope = opts.callContext.sessionScope;
            if (scope?.kind === 'detached-fresh') {
              batchScopes.push(scope);
              batchCallbacks.push({
                hasSessionId: 'sessionId' in opts.callbacks,
                onSessionId: typeof opts.callbacks.onSessionId,
                onQuestion: typeof opts.callbacks.onQuestion,
                onCallEvent: typeof opts.callbacks.onCallEvent,
              });
              return spawnBatch({ h, prompt: opts.prompt, callContext: opts.callContext });
            }
            return spawnBatch({
              h,
              prompt: opts.prompt,
              callContext: {
                ...opts.callContext,
                sessionScope: { kind: 'workflow', workflowSessionId: null },
              },
            });
          },
          backendKind: 'cli',
          runnerName: 'opencode',
          compiler: { invocation: invocationFixture(envelope), ledger },
        },
        { feature: 'feature', projectDir: h.projectDir, callbacks },
      );

      expect(result.tasks.map((task) => String(task.id))).toEqual(
        Array.from({ length: count }, (_, index) => `T${String(index + 1).padStart(3, '0')}`),
      );
      expect(batchScopes).toHaveLength(2);
      expect(batchScopes.map((scope) => scope.batchId)).toEqual([
        program.batches[0]?.batchId,
        program.batches[1]?.batchId,
      ]);
      expect(new Set(batchScopes.map((scope) => scope.attemptId)).size).toBe(2);
      expect(batchCallbacks).toHaveLength(2);
      for (const captured of batchCallbacks) {
        expect(captured.hasSessionId).toBe(false);
        expect(captured.onSessionId).toBe('undefined');
        expect(captured.onQuestion).toBe('undefined');
        expect(captured.onCallEvent).toBe('undefined');
      }
      expect(workflowCounts).toEqual({ onSessionId: 0, onSessionExpired: 0, onQuestion: 0 });
      expect(ledger.snapshot().dispatchCount).toBe(2);
      expect(markerCount()).toBe(5);
      for (let index = 4; index <= 5; index += 1) {
        const marker = readMarker(index);
        expect(marker.mode).toBe('batch');
        expect(marker.argv).toContain('--agent plan');
        expect(marker.argv).not.toContain('--resume');
        expect(marker.argv).not.toContain('--session');
        expect(Number.parseInt(marker.prompt_bytes ?? '', 10)).toBeGreaterThan(0);
      }
    });
  });

  describe('production factory admission and current-call final response (REQ-047, REQ-010)', () => {
    it('creates the opencode planner through the production factory and review returns the current call sentinel byte-for-byte', async () => {
      const h = currentHarness();
      setModes(['final', 'final']);
      const slot = { role: 'planner' } as const;
      const preparationId = 'compiler-matrix-planner';
      const gates: readonly RunnerGate[] = [
        { kind: 'cli', slot, preparationId, tool: 'opencode', executable: h.receipt },
      ];
      const planner = await createPlanner(h.config, {
        preparedConfig: h.config,
        preparationId,
        gates,
        slot,
        initialSessionId: null,
      });

      const first = await planner.review('review the staged plan first', h.projectDir, {
        onOutput: () => {},
      });
      const second = await planner.review('review the staged plan second', h.projectDir, {
        onOutput: () => {},
      });

      expect(first.text).toBe(SENTINEL_A);
      expect(second.text).toBe(SENTINEL_B);
      expect(markerCount()).toBe(2);
    });
  });
});
