import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EvidenceLedger } from '../../src/core/schemas/evidence.js';
import type { Task } from '../../src/core/schemas/task.js';
import type { SessionRef } from '../../src/core/types/session-ref.js';
import { ensureSessionDir } from '../../src/core/paths-io.js';
import {
  createEvidenceLedger,
  findOrSeed,
  upsertEvidenceTask,
} from '../../src/core/evidence/ledger-state.js';
import { hashTaskBrief } from '../../src/core/evidence/brief-hash.js';
import {
  evidenceLedgerPath,
  readEvidenceLedger,
  writeEvidenceLedger,
} from '../../src/core/evidence/ledger-storage.js';
import { sha256Hex } from '../../src/utils/sha256.js';
import { applyFileBundle } from '../../src/engine/implementers/apply-file-bundle.js';
import { captureBundleBaseline } from '../../src/engine/implementers/bundle-baseline.js';
import type { BundleApplyResult } from '../../src/engine/implementers/file-bundle.js';
import {
  getChangedFilesSinceSnapshot,
  type getChangedFilesSnapshot,
} from '../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import { createStagedProject } from '../../src/engine/orchestrator/approval/staged-project.js';
import { recordApiApplyEvidence } from '../../src/engine/orchestrator/evidence/task.js';
import { runRetryStep } from '../../src/engine/orchestrator/escalation/step.js';
import { makeTask } from './factories/task.js';
import { makeImplState } from './factories/workflow-state.js';
import { makeNoValidationConfig } from './factories/config.js';
import { makeWctx } from './orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from './temp-dir.js';
import type { Config } from '../../src/core/schemas/config.js';

export const TARGET_WRITE_SESSION_ID = 'sess-f3-validator';
export const TARGET_WRITE_FILE = 'src/current.ts';

const createdProjects: string[] = [];
const createdWorkspaces: Array<() => void> = [];
const spawnedActors: ChildProcess[] = [];

/** The project every ownership case starts from: one target file and a live session. */
export function createTargetWriteProject(): { projectDir: string; task: Task } {
  const projectDir = createTempDir('target-write-ownership');
  createdProjects.push(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'original');
  ensureSessionDir(projectDir, TARGET_WRITE_SESSION_ID);
  return {
    projectDir,
    task: makeTask({
      id: 'T001',
      status: 'in_progress',
      action: 'modify',
      suggestedFiles: [TARGET_WRITE_FILE],
    }),
  };
}

/** Removes every project and staged workspace this module created for one test. */
export function cleanupTargetWriteFixtures(): void {
  for (const child of spawnedActors.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The actor already exited; cleanup stays best-effort.
    }
  }
  for (const projectDir of createdProjects.splice(0)) cleanupTempDir(projectDir);
  while (createdWorkspaces.length > 0) createdWorkspaces.pop()?.();
}

/** A staged workspace over the project, disposed with the rest of the fixture state. */
export async function createTargetWriteWorkspace(
  projectDir: string,
): Promise<Awaited<ReturnType<typeof createStagedProject>>> {
  const workspace = await createStagedProject({ projectDir: projectDir });
  createdWorkspaces.push(workspace.cleanup);
  return workspace;
}

export function makeTargetWriteConfig(): Config {
  return makeNoValidationConfig({ approval: { feedRejectionsToPlanner: true } });
}

function ledgerFor(projectDir: string, task: Task): EvidenceLedger {
  return (
    readEvidenceLedger({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }) ??
    createEvidenceLedger({ sessionId: TARGET_WRITE_SESSION_ID, feature: 'test', tasks: [task] })
  );
}

/** Records a completed promotion receipt for `content`; `null` is a recorded deletion. */
export function writePromotedReceipt(opts: {
  projectDir: string;
  task: Task;
  content: string | null;
}): void {
  const ledger = ledgerFor(opts.projectDir, opts.task);
  const entry = findOrSeed(ledger, opts.task);
  entry.promotedBriefHash = hashTaskBrief([opts.task]);
  entry.promotedFiles = [
    {
      path: TARGET_WRITE_FILE,
      sha256: opts.content === null ? null : sha256Hex(opts.content),
      mode: opts.content === null ? null : 0o644,
    },
  ];
  writeEvidenceLedger(
    { projectDir: opts.projectDir, sessionId: TARGET_WRITE_SESSION_ID },
    upsertEvidenceTask(ledger, entry),
  );
}

/** Applies one declared target directly, as an API response does. */
export async function applyTargetBundle(opts: {
  projectDir: string;
  task: Task;
  content: string;
}): Promise<BundleApplyResult> {
  const captured = await captureBundleBaseline({ projectDir: opts.projectDir, task: opts.task });
  if (captured.kind !== 'captured') throw new Error(captured.error);
  return applyFileBundle({
    projectDir: opts.projectDir,
    callId: 'call-f3',
    baselines: captured.baselines,
    candidates: [{ path: TARGET_WRITE_FILE, action: 'modify', content: opts.content }],
    noops: [],
  });
}

/** Records the API application's own receipt. */
export function writeApiReceipt(opts: {
  projectDir: string;
  task: Task;
  result: BundleApplyResult;
  workspacePath?: string | undefined;
}): void {
  writeEvidenceLedger(
    { projectDir: opts.projectDir, sessionId: TARGET_WRITE_SESSION_ID },
    recordApiApplyEvidence({
      ledger: ledgerFor(opts.projectDir, opts.task),
      task: opts.task,
      result: opts.result,
      workspacePath: opts.workspacePath,
    }),
  );
}

/** One retry step over the given workspace and invokeRetry, exactly as escalation runs it. */
export async function runTargetWriteRetry(opts: {
  projectDir: string;
  task: Task;
  workspace: Awaited<ReturnType<typeof createStagedProject>>;
  taskStartSnapshot: Awaited<ReturnType<typeof getChangedFilesSnapshot>>;
  invokeRetry: Parameters<typeof runRetryStep>[0]['invokeRetry'];
}): Promise<Awaited<ReturnType<typeof runRetryStep>>> {
  const wctx = makeWctx({
    projectDir: opts.projectDir,
    sessionId: TARGET_WRITE_SESSION_ID,
    config: makeTargetWriteConfig(),
    isolation: {
      open: async () => ({
        kind: 'staged-copy',
        projectDir: opts.workspace.projectDir,
        head: null,
        keptFiles: [],
      }),
      acquire: async () => ({
        ...opts.workspace,
        changedFiles: () =>
          getChangedFilesSinceSnapshot(opts.workspace.projectDir, opts.workspace.snapshot),
        revert: () => Promise.reject(new Error('a target-write retry denies nothing')),
      }),
      dispose: async () => {},
    },
  });
  return runRetryStep({
    ctx: {
      ...wctx,
      taskStartSnapshot: opts.taskStartSnapshot,
      dependsOnFiles: [],
      taskStartTime: Date.now(),
    },
    task: opts.task,
    state: makeImplState([opts.task]),
    lastError: 'retry',
    attempts: 1,
    method: 'local',
    transitionType: 'VALIDATION_PASS',
    usageCategory: 'implementer',
    retryFailureFallback: 'failed',
    invokeRetry: opts.invokeRetry,
  });
}

/** Removes the write bit from a directory so one target write fails at the filesystem. */
export function freezeDir(dir: string): void {
  chmodSync(dir, 0o555);
}

/** Puts a frozen directory back, so fixture cleanup can remove what it holds. */
export function thawDir(dir: string): void {
  chmodSync(dir, 0o755);
}

/**
 * Refuses every evidence-ledger write at the confinement boundary. With `keepReadable` the
 * ledger keeps answering its last value while writes fail; without it the ledger reads as absent.
 */
export function blockEvidenceWrites(opts: { ref: SessionRef; keepReadable?: boolean }): void {
  const path = evidenceLedgerPath(opts.ref);
  if (opts.keepReadable === true) {
    const backup = `${path}.original`;
    renameSync(path, backup);
    symlinkSync(backup, path);
    return;
  }
  symlinkSync(join(dirname(path), 'unavailable-evidence.json'), path);
}

/** How long a fixture actor waits for its window before it gives up; a backstop, not a pace. */
const ACTOR_DEADLINE_MS = 20_000;

/** The first stdout line every actor prints once it is polling; the caller awaits `ready`. */
const ACTOR_READY_LINE = 'fixture-actor-ready';

/**
 * A separate process doing one boundary act. `ready` resolves when the process is polling
 * (or has already failed); `done` resolves once it did the act, and throws otherwise.
 */
export type FixtureActor = Readonly<{ ready: Promise<void>; done: () => Promise<void> }>;

export function startActor(opts: { script: string; label: string }): FixtureActor {
  const { script, label } = opts;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawnedActors.push(child);
  let stdout = '';
  let stderr = '';
  let readySeen = false;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (!readySeen && stdout.includes(ACTOR_READY_LINE)) {
      readySeen = true;
      markReady();
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const settled = new Promise<string | null>((resolve) => {
    child.on('error', (err) => {
      markReady();
      resolve(String(err));
    });
    child.on('exit', (code, signal) => {
      // A process that exited before announcing readiness still unblocks `ready`; `done`
      // then reports why instead of hanging the case.
      markReady();
      const detail = stderr.trim() === '' ? '' : `: ${stderr.trim()}`;
      resolve(code === 0 ? null : `exited code=${String(code)} signal=${String(signal)}${detail}`);
    });
  });
  return {
    ready,
    done: async () => {
      const failure = await settled;
      if (failure !== null) throw new Error(`${label} ${failure}`);
    },
  };
}

/**
 * A separate process that overwrites `targetPath` with `replacement` the moment the
 * writer's bytes are visible there, and does nothing before that. This is how a case
 * reaches the window between a write and the receipt or verification that later reads
 * the same path — through the process and filesystem boundary, with no internal
 * interception. Await `ready` before the production call: a process still booting when
 * the write lands would miss the window.
 */
export function startOperatorReplacementWhenWritten(opts: {
  targetPath: string;
  writtenPrefix: string;
  replacement: string;
}): FixtureActor {
  const script = `
const { closeSync, openSync, readSync, writeFileSync } = require('node:fs');
const target = ${JSON.stringify(opts.targetPath)};
const prefix = ${JSON.stringify(opts.writtenPrefix)};
const replacement = ${JSON.stringify(opts.replacement)};
const expected = Buffer.byteLength(prefix);
const head = Buffer.alloc(expected);
const deadline = Date.now() + ${ACTOR_DEADLINE_MS};
process.stdout.write(${JSON.stringify(`${ACTOR_READY_LINE}\n`)});
while (Date.now() < deadline) {
  let fd;
  try {
    fd = openSync(target, 'r');
    const read = readSync(fd, head, 0, expected, 0);
    closeSync(fd);
    fd = undefined;
    if (read === expected && head.toString('utf8', 0, read) === prefix) {
      writeFileSync(target, replacement);
      process.exit(0);
    }
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}
process.exit(2);
`;
  return startActor({ script, label: 'operator replacement actor' });
}
