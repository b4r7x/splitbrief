import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createStagedProject } from '../approval/staged-project.js';
import { gateAndPromoteChangedFiles } from '../approval/gate-and-promote.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import type { IsolatedWorkspace } from './types.js';
import { createRunIsolation } from './create.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

// An empty repository, never staged and never committed: isolation reads the
// project through git status, and every file here stays untracked.
function tempProject(name: string): string {
  const dir = createTempDir(name);
  dirs.push(dir);
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
}

async function acquire(projectDir: string): Promise<IsolatedWorkspace> {
  const workspace = await createStagedProject(projectDir);
  dirs.push(workspace.projectDir);
  return workspace;
}

async function gate(projectDir: string, workspace: IsolatedWorkspace, file: string) {
  const task = makeTask({ id: 'T010', file });
  return gateAndPromoteChangedFiles({
    task,
    state: makeImplState([task]),
    projectDir,
    workspace,
    taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
    sessionId: 'sess-baseline',
    bus: makeBusRecorder().bus,
    callbacks: makeCallbacks().callbacks,
    config: makeNoValidationConfig({ approval: { enabled: false, feedRejectionsToPlanner: true } }),
    usesIsolation: true,
    dependsOnFiles: [],
    handleConflict: async (s) => s,
    onApproved: () => {},
  });
}

function conflictedFiles(outcome: Awaited<ReturnType<typeof gate>>): string[] {
  return outcome.outcome === 'promote-conflict' ? outcome.conflictedFiles : [];
}

describe('target acquisition baseline', () => {
  it('conflicts instead of overwriting a text edit the user made after acquisition', async () => {
    const projectDir = tempProject('baseline-project');
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'original\n');

    const workspace = await acquire(projectDir);
    writeFileSync(join(workspace.projectDir, 'src', 'app.ts'), 'worker\n');
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'user edit\n');

    const outcome = await gate(projectDir, workspace, 'src/app.ts');

    expect(outcome.outcome).toBe('promote-conflict');
    expect(conflictedFiles(outcome)).toEqual(['src/app.ts']);
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('user edit\n');
  });

  it('conflicts on a binary user edit that decodes to the same text', async () => {
    const projectDir = tempProject('baseline-project');
    // Both payloads decode to U+FFFD: only a digest separates them.
    writeFileSync(join(projectDir, 'logo.bin'), Buffer.from([0xff]));

    const workspace = await acquire(projectDir);
    writeFileSync(join(workspace.projectDir, 'logo.bin'), Buffer.from([0x89, 0x50]));
    writeFileSync(join(projectDir, 'logo.bin'), Buffer.from([0xfe]));

    const outcome = await gate(projectDir, workspace, 'logo.bin');

    expect(outcome.outcome).toBe('promote-conflict');
    expect(conflictedFiles(outcome)).toEqual(['logo.bin']);
    expect(readFileSync(join(projectDir, 'logo.bin'))).toEqual(Buffer.from([0xfe]));
  });

  it('conflicts when the user creates the file the worker also created', async () => {
    const projectDir = tempProject('baseline-project');

    const workspace = await acquire(projectDir);
    mkdirSync(join(workspace.projectDir, 'src'), { recursive: true });
    writeFileSync(join(workspace.projectDir, 'src', 'new.ts'), 'worker\n');
    writeFileSync(join(projectDir, 'src', 'new.ts'), 'user\n');

    const outcome = await gate(projectDir, workspace, 'src/new.ts');

    expect(outcome.outcome).toBe('promote-conflict');
    expect(conflictedFiles(outcome)).toEqual(['src/new.ts']);
    expect(readFileSync(join(projectDir, 'src', 'new.ts'), 'utf-8')).toBe('user\n');
  });

  it('conflicts when the user deleted the file the worker changed', async () => {
    const projectDir = tempProject('baseline-project');
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'original\n');

    const workspace = await acquire(projectDir);
    writeFileSync(join(workspace.projectDir, 'src', 'app.ts'), 'worker\n');
    rmSync(join(projectDir, 'src', 'app.ts'));

    const outcome = await gate(projectDir, workspace, 'src/app.ts');

    expect(outcome.outcome).toBe('promote-conflict');
    expect(conflictedFiles(outcome)).toEqual(['src/app.ts']);
    expect(existsSync(join(projectDir, 'src', 'app.ts'))).toBe(false);
  });

  itUnix('promotes a new executable while an unrelated user file stands aside', async () => {
    const projectDir = tempProject('baseline-project');

    const workspace = await acquire(projectDir);
    writeFileSync(join(workspace.projectDir, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(workspace.projectDir, 'run.sh'), 0o755);
    writeFileSync(join(projectDir, 'src', 'notes.md'), 'user notes\n');

    const outcome = await gate(projectDir, workspace, 'run.sh');

    expect(outcome.outcome).toBe('allow');
    expect(statSync(join(projectDir, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(projectDir, 'src', 'notes.md'), 'utf-8')).toBe('user notes\n');
  });

  it('captures a fresh baseline on every acquisition of a reused isolation', async () => {
    const projectDir = tempProject('baseline-project');
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'first\n');

    const isolation = createRunIsolation({
      projectDir,
      sessionId: 'sess-baseline',
      strategy: 'staged-copy',
      onFallback: () => {},
      onRetained: () => {},
    });
    const config = makeNoValidationConfig();
    const first = await isolation.acquire({ role: 'implementer', config, writesFiles: 'direct' });
    dirs.push(first.projectDir);
    first.cleanup();

    // The target moves on between the two acquisitions: a baseline carried over
    // from the first one would report the second task's promotion as a conflict.
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'second\n');

    const second = await isolation.acquire({ role: 'implementer', config, writesFiles: 'direct' });
    dirs.push(second.projectDir);
    writeFileSync(join(second.projectDir, 'src', 'app.ts'), 'worker\n');

    const outcome = await gate(projectDir, second, 'src/app.ts');

    expect(outcome.outcome).toBe('allow');
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('worker\n');
    await isolation.dispose();
  });
});
