import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CliExecutableReceiptSchema,
  formatDigestBoundExecutableFingerprint,
} from '../../../src/core/discovery/detection.js';
import type { CliImplementerConfig } from '../../../src/core/schemas/implementer-config.js';
import type { RunnerFailureOutcomeState } from '../../../src/engine/runners/errors.js';
import { isolationWorktreePath, SANDBOX_DIR } from '../../../src/core/paths.js';
import { parseTasksStrict } from '../../../src/engine/spec/tasks/parse.js';
import { formatTasks } from '../../../src/engine/spec/formatter.js';
import { createCliImplementer } from '../../../src/engine/implementers/cli.js';
import { runImplementation } from '../../../src/engine/orchestrator/task/run-implementation.js';
import { runSingleTask } from '../../../src/engine/orchestrator/task/step.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { getChangedFilesSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import type { CliStartGate } from '../../../src/engine/runners/start-gate.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  makeWctx,
  makeWorktreeIsolation,
} from '#testing/helpers/orchestrator-factories.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import {
  prependPath,
  type ContractShimMode,
  type ContractShimProfile,
} from '#testing/helpers/command-shim.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../src/engine/runners/prepared-execution.js';
import { resolveCustomExecutable } from '../../../src/engine/runners/resolve-cli-executable.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';

const TARGET_SRC = 'src/change-proof.ts';
const TARGET_TEST = 'tests/change-proof.test.mjs';
const MARKER = 'direct-writer-valid';
const PROMPT_HEAD = 'CHANGE_PROOF_HEAD ';
const PROMPT_TAIL = ' CHANGE_PROOF_TAIL';

const OPENCODE_PROFILE: ContractShimProfile = {
  transport: 'argv',
  versionLine: 'opencode 1.18.15',
  successLines: [
    '{"type":"text","part":{"type":"text","text":"ok"}}',
    '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":12,"output":8}}}',
  ],
  authArgv: ['auth'],
};

type ShimFixture = {
  shimDir: string;
  captureDir: string;
  outsidePath: string;
  restorePath: () => void;
  trustedGate: CliStartGate;
};

const dirs: string[] = [];
const fixtures: ShimFixture[] = [];
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
let originalPath: string | undefined;
let testStateHome: string;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function trustedGateFor(shimDir: string): CliStartGate {
  const commandPath = join(shimDir, 'opencode');
  const path = realpathSync(commandPath);
  const info = statSync(path);
  const fingerprint = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
  const contentDigest = createHash('sha256').update(readFileSync(path)).digest('hex');
  const digestFingerprint = formatDigestBoundExecutableFingerprint({
    fingerprint,
    contentDigest,
  });
  if (digestFingerprint === null) throw new Error('shim fingerprint failed');
  return {
    tool: 'opencode',
    executable: CliExecutableReceiptSchema.parse({
      path,
      fingerprint,
      executableIdentity: {
        canonicalPath: commandPath,
        realPath: path,
        platformFileId: `${info.dev}:${info.ino}`,
        fingerprint: digestFingerprint,
        resolvedAt: Date.now(),
      },
    }),
  };
}

function implementerConfig(): CliImplementerConfig {
  return {
    kind: 'cli',
    tool: 'opencode',
    authChannel: 'provider-dependent',
    model: 'opencode/test-direct-writer',
    contextLength: 4096,
    temperature: 0.1,
  };
}

function proofTask() {
  const task = makeTask({
    id: 'T001',
    action: 'create',
    file: TARGET_SRC,
    title: 'Direct writer change proof module',
    description: `${PROMPT_HEAD}create the change proof module${PROMPT_TAIL}`,
    implementationSteps: [
      'Create the scoped source module with the expected marker export.',
      'Add a companion test that asserts the marker export.',
    ],
    tests: ['node validate.mjs passes', 'companion test asserts the marker export'],
    scope: { inBounds: ['direct writer proof module'], outOfBounds: ['unrelated files'] },
    evidence: ['brief-quality.json confirms the task brief is complete'],
    escalation: ['Stop if the scoped source path is not writable.'],
    typeDefs: 'export const marker: string',
  });
  const parsed = parseTasksStrict(formatTasks([task]))[0];
  if (parsed === undefined) throw new Error('expected the canonical proof task fixture');
  return parsed;
}

function seedValidationProject(projectDir: string): void {
  writeFileSync(
    join(projectDir, 'validate.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      `const marker = ${JSON.stringify(MARKER)};`,
      `const content = readFileSync('${TARGET_SRC}', 'utf-8');`,
      'if (!content.includes(marker)) {',
      '  console.error("expected marker in source file");',
      '  process.exit(1);',
      '}',
    ].join('\n') + '\n',
    'utf-8',
  );
}

function setupProject(): string {
  const projectDir = createTempDir('orch-int-direct-writer-proof');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  writeFileSync(
    join(projectDir, '.gitignore'),
    ['dist/', '*.log', '.splitbrief/\n'].join('\n'),
    'utf-8',
  );
  seedValidationProject(projectDir);
  return projectDir;
}

type ShimMode = ContractShimMode | 'irrelevant-write' | 'valid-change';

function writeOpencodeProofShim(opts: {
  dir: string;
  captureDir: string;
  mode: ShimMode;
  outsidePath?: string;
}): void {
  const successLines = OPENCODE_PROFILE.successLines
    .map((line) => `printf '%s\\n' ${shellQuote(line)}`)
    .join('\n');
  const outsideWrite =
    opts.outsidePath === undefined
      ? ''
      : `mkdir -p "$(dirname ${shellQuote(opts.outsidePath)})"\nprintf 'outside\\n' > ${shellQuote(opts.outsidePath)}`;
  const modeBody: Record<ShimMode, string> = {
    'valid-change': [
      'mkdir -p src',
      `printf 'export const marker = "${MARKER}";\\n' > '${TARGET_SRC}'`,
      successLines,
      'exit 0',
    ].join('\n'),
    'success-direct': [
      'mkdir -p src tests',
      `printf 'export const marker = "${MARKER}";\\n' > '${TARGET_SRC}'`,
      `cat > '${TARGET_TEST}' <<'EOF'`,
      "import { readFileSync } from 'node:fs';",
      `const marker = ${JSON.stringify(MARKER)};`,
      `const src = readFileSync('${TARGET_SRC}', 'utf-8');`,
      'if (!src.includes(marker)) {',
      '  console.error("marker mismatch");',
      '  process.exit(1);',
      '}',
      'console.log("ok");',
      'EOF',
      successLines,
      'exit 0',
    ].join('\n'),
    'no-op': [successLines, 'exit 0'].join('\n'),
    'outside-write': [outsideWrite || 'true', successLines, 'exit 0'].join('\n'),
    'provider-state-write': [
      'mkdir -p .splitbrief',
      "printf '{}\\n' > .splitbrief/provider-state.json",
      successLines,
      'exit 0',
    ].join('\n'),
    'irrelevant-write': [
      'mkdir -p .splitbrief',
      "printf 'ignored\\n' > .splitbrief/irrelevant.log",
      successLines,
      'exit 0',
    ].join('\n'),
    'non-zero-exit': "printf 'fixture stderr\\n' >&2\nexit 17",
    'protocol-failure': "printf 'not-a-protocol-line\\n'\nexit 0",
    'partial-protocol': `${successLines.split('\n')[0] ?? 'true'}\nprintf 'not-a-protocol-line\\n'\nexit 0`,
    timeout: 'while true; do sleep 1; done',
    'abort-wait': 'while true; do sleep 1; done',
    'signal-exit': 'kill -TERM "$$"',
    'output-flood': 'while true; do printf flood; done',
  };

  const script = [
    '#!/bin/bash',
    'set -euo pipefail',
    `CAPTURE_DIR=${shellQuote(opts.captureDir)}`,
    `MODE=${shellQuote(opts.mode)}`,
    `VERSION_LINE=${shellQuote(OPENCODE_PROFILE.versionLine)}`,
    'if [[ " $* " == *" --version "* ]]; then',
    '  printf \'%s\\n\' "$VERSION_LINE"',
    '  exit 0',
    'fi',
    'if [[ -n "$CAPTURE_DIR" ]]; then',
    '  mkdir -p "$CAPTURE_DIR"',
    '  printf \'%s\\n\' "$@" > "$CAPTURE_DIR/argv.lines"',
    '  printf \'%s\' "$(pwd)" > "$CAPTURE_DIR/cwd.txt"',
    'fi',
    modeBody[opts.mode],
  ].join('\n');
  const shimPath = join(opts.dir, 'opencode');
  writeFileSync(shimPath, script + '\n', 'utf-8');
  chmodSync(shimPath, 0o755);
}

function createShimFixture(_projectDir: string, mode: ShimMode): ShimFixture {
  const shimDir = createTempDir('direct-writer-proof-shim');
  const captureDir = join(shimDir, 'capture');
  mkdirSync(captureDir, { recursive: true });
  const outsidePath = join(shimDir, 'outside-write.txt');

  writeOpencodeProofShim({
    dir: shimDir,
    captureDir,
    mode,
    ...(mode === 'outside-write' ? { outsidePath } : {}),
  });

  const fixture: ShimFixture = {
    shimDir,
    captureDir,
    outsidePath,
    restorePath: prependPath(shimDir),
    trustedGate: trustedGateFor(shimDir),
  };
  fixtures.push(fixture);
  return fixture;
}

async function runDirectWriterImplementation(
  fixture: ShimFixture,
  projectDir: string,
): Promise<Awaited<ReturnType<typeof runImplementation>>> {
  const sessionId = 'sess-direct-writer-proof';
  const task = proofTask();
  const state = makeImplState([task]);
  const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
  const { bus } = makeBusRecorder();
  const wctx = makeWctx({
    projectDir,
    sessionId,
    bus,
    config: makeConfig({
      implementer: implementerConfig(),
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { mode: 'quick', maxRetries: 0, persistTranscript: false },
    }),
  });
  wctx.implementer = createCliImplementer(implementerConfig(), { trustedCli: fixture.trustedGate });

  return runImplementation({
    wctx,
    task,
    state,
    taskStartSnapshot,
    setTrackedState: () => {},
    recordApprovalDenial: () => {},
  });
}

beforeEach(() => {
  resetAllStores();
  originalPath = process.env.PATH;
  testStateHome = createTempDir('direct-writer-state-home');
  process.env.XDG_STATE_HOME = testStateHome;
});

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    fixture.restorePath();
    cleanupTempDir(fixture.shimDir);
  }
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
  cleanupTempDir(testStateHome);
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
});

describe('direct-writer workflow change proof', { timeout: 90_000 }, () => {
  it.each([
    ['no-op', 'no-op'],
    ['outside-project', 'outside-write'],
    ['provider-state-only', 'provider-state-write'],
    ['irrelevant change', 'irrelevant-write'],
  ] as const)('%s returns no-staged-change', async (_label, mode) => {
    const projectDir = setupProject();
    const fixture = createShimFixture(projectDir, mode);

    const result = await runDirectWriterImplementation(fixture, projectDir);

    expect(result.usesIsolation).toBe(true);
    expect(result.workspace?.projectDir).not.toBe(projectDir);
    expect(result.implResult.success).toBe(false);
    if (result.implResult.success) throw new Error('expected implementation failure');
    const outcome: RunnerFailureOutcomeState | undefined = result.implResult.outcome;
    expect(outcome).toBe('no-staged-change');
    expect(existsSync(join(projectDir, TARGET_SRC))).toBe(false);
    expect(existsSync(join(projectDir, TARGET_TEST))).toBe(false);

    if (mode === 'outside-write') {
      expect(existsSync(fixture.outsidePath)).toBe(true);
    }
    const workspaceDir = result.workspace?.projectDir;
    if (mode === 'provider-state-write' && workspaceDir !== undefined) {
      expect(existsSync(join(workspaceDir, '.splitbrief/provider-state.json'))).toBe(true);
    }
    if (mode === 'irrelevant-write' && workspaceDir !== undefined) {
      expect(existsSync(join(workspaceDir, '.splitbrief/irrelevant.log'))).toBe(true);
    }

    result.workspace?.cleanup();
  });

  it('promotes a direct write made in the run worktree into the project', async () => {
    const projectDir = setupProject();
    const fixture = createShimFixture(projectDir, 'valid-change');
    const sessionId = 'sess-direct-writer-worktree';
    ensureSessionDir(projectDir, sessionId);
    const isolation = makeWorktreeIsolation({ projectDir, sessionId });
    const task = proofTask();
    const state = makeImplState([task]);

    try {
      const result = await runSingleTask({
        wctx: makeWctx({
          projectDir,
          sessionId,
          isolation,
          implementer: createCliImplementer(implementerConfig(), {
            trustedCli: fixture.trustedGate,
          }),
          config: makeConfig({
            implementer: implementerConfig(),
            validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
            workflow: { mode: 'quick', maxRetries: 0, persistTranscript: false },
            approval: { enabled: false, feedRejectionsToPlanner: false },
          }),
        }),
        task,
        index: 0,
        totalTasks: 1,
        state,
        taskBreakdowns: [],
        setTrackedState: () => {},
        setCurrentTask: () => {},
      });

      const shimCwd = readFileSync(join(fixture.captureDir, 'cwd.txt'), 'utf-8');
      expect(realpathSync(shimCwd)).toBe(
        realpathSync(isolationWorktreePath(join(realpathSync(projectDir), '.git'), sessionId)),
      );
      expect(statSync(join(shimCwd, '.git')).isFile()).toBe(true);
      expect(result.tasks[0]?.status).toBe('done');
      expect(readFileSync(join(projectDir, TARGET_SRC), 'utf-8')).toBe(
        `export const marker = "${MARKER}";\n`,
      );
    } finally {
      await isolation.dispose();
    }
  });

  it('promotes a rewrite of a file the run worktree was already dirty in', async () => {
    const projectDir = setupProject();
    // The worktree is seeded with the source checkout's uncommitted work, so a
    // dirty unrelated file is already in its git status before the implementer
    // runs. The declared file is new to the status, so the exact-effect gate
    // counts the shim's write as the one staged change; a pre-existing dirty
    // declared file would call a rewrite a no-op run, and every retry of an
    // already-written task keeps this shape.
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(
      join(projectDir, 'src/unrelated-dirty.ts'),
      'export const dirty = true;\n',
      'utf-8',
    );
    const fixture = createShimFixture(projectDir, 'valid-change');
    const sessionId = 'sess-direct-writer-already-dirty';
    ensureSessionDir(projectDir, sessionId);
    const isolation = makeWorktreeIsolation({ projectDir, sessionId });
    const task = proofTask();
    const state = makeImplState([task]);

    try {
      const result = await runSingleTask({
        wctx: makeWctx({
          projectDir,
          sessionId,
          isolation,
          implementer: createCliImplementer(implementerConfig(), {
            trustedCli: fixture.trustedGate,
          }),
          config: makeConfig({
            implementer: implementerConfig(),
            validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
            workflow: { mode: 'quick', maxRetries: 0, persistTranscript: false },
            approval: { enabled: false, feedRejectionsToPlanner: false },
          }),
        }),
        task,
        index: 0,
        totalTasks: 1,
        state,
        taskBreakdowns: [],
        setTrackedState: () => {},
        setCurrentTask: () => {},
      });

      expect(result.tasks[0]?.status).toBe('done');
      expect(readFileSync(join(projectDir, TARGET_SRC), 'utf-8')).toBe(
        `export const marker = "${MARKER}";\n`,
      );
    } finally {
      await isolation.dispose();
    }
  });

  it('promotes a valid source and test change through approval without unrelated promotion', async () => {
    const projectDir = setupProject();
    const fixture = createShimFixture(projectDir, 'valid-change');
    const sessionId = 'sess-direct-writer-valid';
    const events: EngineEvent[] = [];
    const task = proofTask();
    const planner = makePlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [task],
        usage: { inputTokens: 40, outputTokens: 20 },
      }),
    });

    const feature = 'prove direct writer promotion';
    const resumeState = persistReadyExecutionState(projectDir, sessionId, makeImplState([task]));
    const config = parsePreparedConfig(
      makeConfig({
        planner: {
          kind: 'shell',
          command: 'node',
          args: ['-e', 'process.exit(0)'],
          model: 'noop-planner',
          contextLength: 4096,
        },
        implementer: implementerConfig(),
        validation: {
          typecheck: false,
          lint: false,
          test: true,
          testCommand: 'node validate.mjs',
        },
        workflow: {
          mode: 'quick',
          maxRetries: 0,
          persistTranscript: false,
        },
        approval: { enabled: false, feedRejectionsToPlanner: false },
        escalation: { enabled: false },
      }),
    );
    const preparationId = 'direct-writer-change-proof-preparation';
    const implementerResolution = await resolveCustomExecutable({
      command: 'opencode',
      projectDir,
    });
    if (implementerResolution.kind !== 'resolved') {
      throw new Error('OpenCode fixture executable did not resolve.');
    }
    const active = {
      version: 1 as const,
      sessionId,
      generation: '2a222222-2222-4222-8222-222222222222',
    };
    const prepared: PreparedExecution = {
      purpose: 'new-workflow',
      config,
      preparationId,
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir,
        status: 'ready',
        counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [],
        metadata: {},
      },
      gates: [
        {
          kind: 'shell',
          slot: { role: 'planner' },
          preparationId,
          command: { kind: 'validated-config' },
        },
        {
          kind: 'cli',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          tool: 'opencode',
          executable: implementerResolution.executable,
        },
      ],
      session: { kind: 'existing', ref: { projectDir, sessionId }, active },
      runtime: { feature, allowRepoRunners: false, allowHooks: false, resumeState },
    };

    const summary = await runWorkflow({
      prepared,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _eventSink: (event) => events.push(event),
    });

    expect(summary).toMatchObject({ totalTasks: 1, completedByLocal: 1, failed: 0 });
    const shimCwd = existsSync(join(fixture.captureDir, 'cwd.txt'))
      ? readFileSync(join(fixture.captureDir, 'cwd.txt'), 'utf-8')
      : '';
    expect(shimCwd).not.toBe(projectDir);
    expect(readFileSync(join(projectDir, TARGET_SRC), 'utf-8')).toBe(
      `export const marker = "${MARKER}";\n`,
    );
    expect(existsSync(join(projectDir, 'dist/bundle.js'))).toBe(false);
    expect(existsSync(join(projectDir, SANDBOX_DIR))).toBe(false);
    expect(existsSync(fixture.outsidePath)).toBe(false);
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      failed: 0,
      implementerTool: 'opencode',
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['task_completed', 'workflow_complete']),
    );
    expect(events.find((event) => event.type === 'task_completed')).toMatchObject({
      taskId: 'T001',
      method: 'local',
    });
  });
});
