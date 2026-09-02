import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { sessionDir } from '../../../src/core/paths.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import {
  createCrashHandler,
  createTerminationHandler,
  createTuiCleanup,
} from '../../../src/cli/render/process-lifecycle.js';
import {
  createServerCleanup,
  createServerExitHandlers,
  createServerProcessCleanup,
} from '../../../src/engine/ipc/server-cleanup.js';
import { shutdownWorkflow } from '../../../src/engine/orchestrator/session-lifecycle/shutdown.js';
import {
  killAllProcesses,
  registerProcess,
  unregisterProcess,
} from '../../../src/lib/process/registry.js';

const ESCALATION_DELAY_MS = 2000;
const ESCALATION_TOLERANCE_MS = 50;

type ProcessTreeFixture = {
  dir: string;
  leader: ChildProcess;
  leaderPid: number;
  descendantPid: number;
  leaderTermMarker: string;
  descendantTermMarker: string;
};

const fixtures: ProcessTreeFixture[] = [];
const projectDirs: string[] = [];

function parsePid(value: string, owner: string): number {
  const pid = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`${owner} returned an invalid pid`);
  }
  return pid;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function killFixtureGroup(fixture: ProcessTreeFixture): void {
  if (!isProcessAlive(fixture.leaderPid) && !isProcessAlive(fixture.descendantPid)) return;
  try {
    process.kill(-fixture.leaderPid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function waitForMarker(path: string, timeoutMs = 1000): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() - startedAt < timeoutMs) return;
      clearInterval(interval);
      reject(new Error(`process marker was not written: ${path}`));
    }, 10);
  });
}

async function spawnStubbornProcessTree(): Promise<ProcessTreeFixture> {
  const dir = createTempDir('process-shutdown-reaping');
  const leaderTermMarker = join(dir, 'leader-term');
  const descendantTermMarker = join(dir, 'descendant-term');
  const descendantScript = [
    'const { appendFileSync } = require("node:fs");',
    'const marker = process.argv[1];',
    'process.on("SIGTERM", () => appendFileSync(marker, "SIGTERM\\n"));',
    'process.stdout.write("ready");',
    'setInterval(() => {}, 1000);',
  ].join('');
  const leaderScript = [
    'const { appendFileSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'const leaderMarker = process.argv[1];',
    'const descendantMarker = process.argv[2];',
    'const descendantScript = process.argv[3];',
    'const descendant = spawn(process.execPath, ["-e", descendantScript, descendantMarker], { stdio: ["ignore", "pipe", "ignore"] });',
    'descendant.stdout.once("data", () => process.stdout.write(String(descendant.pid)));',
    'process.on("SIGTERM", () => { appendFileSync(leaderMarker, "SIGTERM\\n"); process.exit(0); });',
    'setInterval(() => {}, 1000);',
  ].join('');
  const leader = spawn(
    process.execPath,
    ['-e', leaderScript, leaderTermMarker, descendantTermMarker, descendantScript],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const leaderPid = leader.pid;
  if (leaderPid === undefined || leaderPid <= 1) {
    leader.kill('SIGKILL');
    cleanupTempDir(dir);
    throw new Error('process-tree leader did not receive a valid pid');
  }

  let descendantPid: number;
  try {
    descendantPid = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('process-tree fixture did not start')),
        3000,
      );
      leader.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      leader.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`process-tree leader exited during startup: ${code ?? signal}`));
      });
      leader.stdout?.once('data', (chunk: Buffer) => {
        clearTimeout(timeout);
        resolve(parsePid(chunk.toString('utf8'), 'process-tree leader'));
      });
    });
  } catch (error) {
    try {
      process.kill(-leaderPid, 'SIGKILL');
    } catch (killError) {
      if (!(killError instanceof Error && 'code' in killError && killError.code === 'ESRCH')) {
        throw killError;
      }
    } finally {
      cleanupTempDir(dir);
    }
    throw error;
  }

  const fixture = {
    dir,
    leader,
    leaderPid,
    descendantPid,
    leaderTermMarker,
    descendantTermMarker,
  } satisfies ProcessTreeFixture;
  fixtures.push(fixture);
  registerProcess(leader, { group: true, ledger: false });
  return fixture;
}

function assertEscalatedAndReaped(fixture: ProcessTreeFixture, startedAt: number): void {
  expect(readFileSync(fixture.leaderTermMarker, 'utf8')).toContain('SIGTERM');
  expect(readFileSync(fixture.descendantTermMarker, 'utf8')).toContain('SIGTERM');
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
    ESCALATION_DELAY_MS - ESCALATION_TOLERANCE_MS,
  );
  expect(isProcessAlive(fixture.descendantPid)).toBe(false);
}

afterEach(async () => {
  await killAllProcesses();
  for (const fixture of fixtures.splice(0)) {
    unregisterProcess(fixture.leader);
    killFixtureGroup(fixture);
    rmSync(fixture.dir, { recursive: true, force: true });
  }
  for (const dir of projectDirs.splice(0)) cleanupTempDir(dir);
});

describe('process shutdown reaping', () => {
  it('reaps a workflow grandchild before persisting state and rolling back the active task', async () => {
    const projectDir = createTempDir('workflow-shutdown-reaping');
    projectDirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'shutdown-reaping';
    ensureSessionDir(projectDir, sessionId);
    const taskFile = 'src/generated.ts';
    const taskPath = join(projectDir, taskFile);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(taskPath, 'export const partial = true;\n');
    const statePath = join(sessionDir(projectDir, sessionId), 'state.json');
    const trackedState = {
      ...createInitialState('shutdown reaping'),
      feature: 'shutdown reaping',
    };
    const fixture = await spawnStubbornProcessTree();
    const startedAt = Date.now();

    const shutdown = shutdownWorkflow({
      projectDir,
      sessionId,
      getTrackedState: () => trackedState,
      getCurrentTask: () => ({ file: taskFile, action: 'create' }),
    });

    await waitForMarker(fixture.descendantTermMarker);
    expect(isProcessAlive(fixture.descendantPid)).toBe(true);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(taskPath)).toBe(true);

    await shutdown;

    assertEscalatedAndReaped(fixture, startedAt);
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(taskPath)).toBe(false);
  });

  it.each([
    { kind: 'signal', expectedExitCode: 0 },
    { kind: 'crash', expectedExitCode: 1 },
  ])('reaps a detached IPC grandchild before $kind cleanup closes or exits', async (scenario) => {
    const fixture = await spawnStubbornProcessTree();
    const startedAt = Date.now();
    const stages: string[] = [];
    const afterReaping = (stage: string) => {
      assertEscalatedAndReaped(fixture, startedAt);
      stages.push(stage);
    };
    const cleanup = createServerCleanup({
      cleanupProcesses: createServerProcessCleanup(),
      stopHeartbeat: () => stages.push('heartbeat-stopped'),
      closeBridge: () => afterReaping('bridge-closed'),
      closeServer: async () => afterReaping('server-closed'),
      terminalize: async (termination) => afterReaping(`terminalized:${termination.kind}`),
      flushTelemetry: async () => afterReaping('telemetry-flushed'),
    });
    const handlers = createServerExitHandlers({
      cleanup,
      exitProcess: (code) => afterReaping(`exit:${code}`),
    });

    if (scenario.kind === 'signal') {
      await handlers.signal('SIGTERM');
    } else {
      await handlers.crash(new Error('fixture crash'));
    }

    expect(stages).toEqual([
      'heartbeat-stopped',
      'bridge-closed',
      'server-closed',
      `terminalized:${scenario.kind}`,
      'telemetry-flushed',
      `exit:${scenario.expectedExitCode}`,
    ]);
  });

  it.each([
    { kind: 'termination', expectedExitCode: 143 },
    { kind: 'crash', expectedExitCode: 1 },
  ])('reaps a TUI grandchild before $kind restores the terminal and exits', async (scenario) => {
    const fixture = await spawnStubbornProcessTree();
    const startedAt = Date.now();
    const stages: string[] = [];
    const afterReaping = (stage: string) => {
      assertEscalatedAndReaped(fixture, startedAt);
      stages.push(stage);
    };
    const cleanup = createTuiCleanup({ restore: () => afterReaping('terminal-restored') });
    const reportCleanupFailure = (error: unknown) => stages.push(`cleanup-failed:${String(error)}`);

    if (scenario.kind === 'termination') {
      await createTerminationHandler({
        cleanup,
        reportCleanupFailure,
        exit: (code) => afterReaping(`exit:${code}`),
      })('SIGTERM');
    } else {
      await createCrashHandler({
        cleanup,
        report: () => afterReaping('crash-reported'),
        reportCleanupFailure,
        exit: (code) => afterReaping(`exit:${code}`),
      })(new Error('fixture crash'));
    }

    expect(stages).toEqual([
      'terminal-restored',
      ...(scenario.kind === 'crash' ? ['crash-reported'] : []),
      `exit:${scenario.expectedExitCode}`,
    ]);
  });
});
