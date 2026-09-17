import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { evidenceLedgerPath, readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { writeSecureFile } from '../../../lib/fs.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';

const control = vi.hoisted(() => ({ failWriteBasename: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (path: Parameters<typeof actual.writeFile>[0], ...rest: unknown[]) => {
      if (
        control.failWriteBasename &&
        typeof path === 'string' &&
        (path.endsWith(control.failWriteBasename) ||
          path.includes(`.${control.failWriteBasename}.tmp.`))
      ) {
        return Promise.reject(new Error('EIO: simulated write failure'));
      }
      return (actual.writeFile as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const { createStagedProject } = await import('./staged-project.js');
const { gateAndPromoteChangedFiles } = await import('./gate-and-promote.js');
const { getChangedFilesSnapshot } = await import('./file-snapshots/capture.js');

const SESSION_ID = 'sess-promotion';
const task = makeTask({ id: 'T011', file: 'src/a.ts' });

let dirs: string[] = [];

afterEach(() => {
  control.failWriteBasename = '';
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

// An empty repository, never staged and never committed: the files below stay
// untracked, which is all the changed-file scan needs.
function initEmptyRepo(dir: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'Test']);
}

/** The implementer stand-in: it writes into the workspace, it never runs a model. */
function mockRunner(workspaceDir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(workspaceDir, file), content);
  }
}

async function acquiredProject(name: string) {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  initEmptyRepo(projectDir);
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'a.ts'), 'target a\n');
  writeFileSync(join(projectDir, 'src', 'b.ts'), 'target b\n');

  const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
  const workspace = await createStagedProject(projectDir);
  dirs.push(workspace.projectDir);
  mockRunner(workspace.projectDir, { 'src/a.ts': 'staged a\n', 'src/b.ts': 'staged b\n' });
  return { projectDir, workspace, taskStartSnapshot, state: makeImplState([task]) };
}

type GateInput = {
  projectDir: string;
  workspace: Awaited<ReturnType<typeof createStagedProject>>;
  taskStartSnapshot: Awaited<ReturnType<typeof getChangedFilesSnapshot>>;
  state: WorkflowState;
  cleanup?: () => void;
};

/** The option shape both the direct apply and the hint tier hand to the gate. */
function runGate(input: GateInput) {
  return gateAndPromoteChangedFiles({
    task,
    state: input.state,
    projectDir: input.projectDir,
    sessionId: SESSION_ID,
    bus: makeBusRecorder().bus,
    callbacks: makeCallbacks().callbacks,
    config: makeNoValidationConfig({
      approval: { enabled: false, feedRejectionsToPlanner: true },
    }),
    workspace: input.workspace,
    usesIsolation: true,
    taskStartSnapshot: input.taskStartSnapshot,
    dependsOnFiles: [],
    catchChangedFilesError: true,
    cleanup: input.cleanup ?? input.workspace.cleanup,
    handleConflict: async (s) => s,
    onApproved: () => {},
  });
}

function ledgerTask(projectDir: string) {
  const ledger = readEvidenceLedger({ projectDir, sessionId: SESSION_ID });
  const entry = ledger?.tasks.find((t) => t.id === task.id);
  if (!ledger || !entry) throw new Error('evidence ledger has no record for the task');
  return { ledger, entry };
}

describe('partial promotion recovery', () => {
  it('records the applied prefix and the failure, and fails the brief', async () => {
    const acquired = await acquiredProject('promotion-recovery');
    const { projectDir, workspace } = acquired;
    const cleanup = vi.fn(workspace.cleanup);
    control.failWriteBasename = 'b.ts';

    const outcome = await runGate({ ...acquired, cleanup });

    expect(outcome.outcome).toBe('error');
    if (outcome.outcome !== 'error') return;
    expect(outcome.promotion?.failedFile).toBe('src/b.ts');
    expect(outcome.promotion?.appliedFiles.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(outcome.promotion?.evidenceError).toBeUndefined();

    // The prefix is on the target, the failing file is untouched, and the
    // workspace keeps the output that never reached the target.
    expect(readFileSync(join(projectDir, 'src', 'a.ts'), 'utf-8')).toBe('staged a\n');
    expect(readFileSync(join(projectDir, 'src', 'b.ts'), 'utf-8')).toBe('target b\n');
    expect(cleanup).not.toHaveBeenCalled();
    expect(existsSync(workspace.projectDir)).toBe(true);

    const { ledger, entry } = ledgerTask(projectDir);
    expect(entry.status).toBe('failed');
    expect(entry.validation).toEqual([]);
    expect(entry.observedEvidence).not.toContain('task reached done');
    expect(ledger.validationSummary).toEqual({ passed: 0, failed: 1, skipped: 0, escalated: 0 });
    expect(entry.changedFiles).toContain('src/a.ts');

    const attempts = entry.promotionAttempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.failedFile).toBe('src/b.ts');
    expect(attempts[0]?.error).toMatch(/simulated write failure/);
    expect(attempts[0]?.appliedFiles).toEqual([
      {
        path: 'src/a.ts',
        sha256: sha256Hex(Buffer.from('staged a\n')),
        mode: statSync(join(projectDir, 'src', 'a.ts')).mode & 0o777,
      },
    ]);

    expect(outcome.state.currentTaskIndex).toBe(acquired.state.currentTaskIndex);
    expect(outcome.state.pendingRecovery?.reason).toBe('approval-promotion-conflict');
  });

  it('conflicts instead of overwriting a user edit to the already promoted file', async () => {
    const acquired = await acquiredProject('promotion-recovery-retry');
    const { projectDir } = acquired;
    control.failWriteBasename = 'b.ts';
    const failed = await runGate(acquired);
    expect(failed.outcome).toBe('error');

    // The user edits the file promotion already applied; nothing rolled it back
    // to the original target bytes, so the edit sits on top of the prefix.
    writeFileSync(join(projectDir, 'src', 'a.ts'), 'user edit\n');
    control.failWriteBasename = '';

    const retry = await runGate(acquired);

    expect(retry.outcome).toBe('promote-conflict');
    expect(retry.outcome === 'promote-conflict' ? retry.conflictedFiles : []).toEqual(['src/a.ts']);
    expect(readFileSync(join(projectDir, 'src', 'a.ts'), 'utf-8')).toBe('user edit\n');
    expect(readFileSync(join(projectDir, 'src', 'b.ts'), 'utf-8')).toBe('target b\n');
  });

  it('stops a hint-tier gated retry on the same partial apply', async () => {
    const acquired = await acquiredProject('promotion-recovery-hint');
    const { projectDir, workspace } = acquired;
    // The hint tier acquires its own workspace and its planner writes into it.
    mockRunner(workspace.projectDir, { 'src/a.ts': 'hint a\n', 'src/b.ts': 'hint b\n' });
    const cleanup = vi.fn(workspace.cleanup);
    control.failWriteBasename = 'b.ts';

    const outcome = await runGate({ ...acquired, cleanup });

    // `allow` is the only outcome the hint tier continues on.
    expect(outcome.outcome).toBe('error');
    expect(cleanup).not.toHaveBeenCalled();
    expect(existsSync(workspace.projectDir)).toBe(true);
    expect(readFileSync(join(projectDir, 'src', 'a.ts'), 'utf-8')).toBe('hint a\n');

    const { entry } = ledgerTask(projectDir);
    expect(entry.status).toBe('failed');
    expect(entry.promotionAttempts?.at(-1)?.failedFile).toBe('src/b.ts');
  });

  it('reports both errors and keeps the workspace when evidence cannot be persisted', async () => {
    const acquired = await acquiredProject('promotion-recovery-evidence');
    const { projectDir, workspace } = acquired;
    // Valid JSON the ledger schema rejects: the read inside the mutation throws.
    writeSecureFile(
      evidenceLedgerPath({ projectDir, sessionId: SESSION_ID }),
      `${JSON.stringify({ version: 2 })}\n`,
    );
    const cleanup = vi.fn(workspace.cleanup);
    control.failWriteBasename = 'b.ts';

    const outcome = await runGate({ ...acquired, cleanup });

    expect(outcome.outcome).toBe('error');
    if (outcome.outcome !== 'error') return;
    expect(outcome.promotion?.evidenceError).toBeDefined();
    expect(outcome.promotion?.appliedFiles.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(outcome.error).toBeInstanceOf(AggregateError);
    expect((outcome.error as AggregateError).errors).toHaveLength(2);
    expect(cleanup).not.toHaveBeenCalled();
    expect(existsSync(workspace.projectDir)).toBe(true);
  });
});
