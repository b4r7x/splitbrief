import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPLITBRIEF_IDENTITY } from '../core/identity.js';
import { SPLITBRIEF_DIR, TREES_DIR } from '../core/paths.js';
import { taskId } from '../core/schemas/task.js';
import { terminalSequences } from '../lib/terminal/control.js';
import {
  resumeTerminalAfterEditor,
  suspendTerminalForEditor,
  type TerminalHandoverConfig,
} from '../lib/terminal/editor-handover.js';
import { eventsStore } from '../stores/workflow/events.js';
import { runViewStore } from '../stores/workflow/run-view.js';
import { addEvent } from '../stores/workflow/actions/event.js';
import { resetWorkflow } from '../stores/workflow/actions/reset.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import type { DetectionCacheSnapshot } from './detection/cache.js';
import { loadDetectionCacheSnapshot, saveDetectionCache } from './detection/cache.js';
import { workflowOptsToCLIOverrides } from '../core/config/runtime/overrides/from-options.js';
import { createWorktree } from './orchestrator/isolation/create-worktree.js';
import { removeWorktree } from './orchestrator/isolation/remove-worktree.js';

const HARD_CUT_CONTEXT = 'runtime-hard-cut-context-v1';

function hardCutSnapshot(): DetectionCacheSnapshot {
  const observedAt = Date.now();
  return {
    contextKey: HARD_CUT_CONTEXT,
    fetchedAt: observedAt,
    validatedAt: observedAt,
    generation: 0,
    requestId: 0,
    providers: [],
    cliTools: [],
  };
}

const PRIOR_STATE_DIRS = [
  '.diptych', // brand-contract-negative
  '.tiny-spec', // brand-contract-negative
] as const;
const CANONICAL_CONTEXT_ENV = 'SPLITBRIEF_CONTEXT_LENGTH';
const PRIOR_CONTEXT_ENV_KEYS = [
  'DIPTYCH_CONTEXT_LENGTH', // brand-contract-negative
  'TINY_SPEC_CONTEXT_LENGTH', // brand-contract-negative
] as const;
const PRIOR_BRANCHES = [
  'diptych/legacy', // brand-contract-negative
  'tiny-spec/legacy', // brand-contract-negative
] as const;

describe('runtime hard cut', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `${SPLITBRIEF_IDENTITY.slug}-runtime-hard-cut-`));
  });

  afterEach(async () => {
    resetWorkflow();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('state-write', async () => {
    const projectDir = join(root, 'state-write');
    await mkdir(join(projectDir, SPLITBRIEF_DIR), { recursive: true });

    await saveDetectionCache({ projectDir, snapshot: hardCutSnapshot() });

    const cachePath = join(projectDir, SPLITBRIEF_DIR, 'detection-cache.json');
    expect(existsSync(cachePath)).toBe(true);
    expect(
      await loadDetectionCacheSnapshot({ projectDir, contextKey: HARD_CUT_CONTEXT }),
    ).toMatchObject({ providers: [], cliTools: [] });
    for (const priorDir of PRIOR_STATE_DIRS) {
      expect(existsSync(join(projectDir, priorDir))).toBe(false);
    }
  });

  it('prior-state-ignore', async () => {
    const projectDir = join(root, 'prior-state-ignore');
    const cache = JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      planners: [],
      providers: [],
    });
    for (const priorDir of PRIOR_STATE_DIRS) {
      const priorPath = join(projectDir, priorDir, 'detection-cache.json');
      await mkdir(join(projectDir, priorDir), { recursive: true });
      await writeFile(priorPath, cache);
    }

    expect(
      await loadDetectionCacheSnapshot({ projectDir, contextKey: HARD_CUT_CONTEXT }),
    ).toBeNull();
    expect(existsSync(join(projectDir, SPLITBRIEF_DIR))).toBe(false);
    for (const priorDir of PRIOR_STATE_DIRS) {
      expect(await readFile(join(projectDir, priorDir, 'detection-cache.json'), 'utf8')).toBe(
        cache,
      );
    }
  });

  it('env-read', () => {
    vi.stubEnv(CANONICAL_CONTEXT_ENV, '4096');
    for (const key of PRIOR_CONTEXT_ENV_KEYS) vi.stubEnv(key, undefined);

    expect(workflowOptsToCLIOverrides({}).implementer?.contextLength).toBe(4096);
  });

  it('prior-env-ignore', () => {
    vi.stubEnv(CANONICAL_CONTEXT_ENV, undefined);
    for (const key of PRIOR_CONTEXT_ENV_KEYS) vi.stubEnv(key, '4096');

    expect(workflowOptsToCLIOverrides({}).implementer?.contextLength).toBeUndefined();
  });

  it('worktree-create', async () => {
    const projectDir = join(root, 'worktree-create');
    await mkdir(projectDir);
    createTestGitRepo(projectDir);
    const git = simpleGit(projectDir);
    const branchesBefore = (await git.branch()).all;

    const worktree = await createWorktree({ projectDir, slug: 'canonical', git });

    expect(worktree).toBe(join(projectDir, TREES_DIR, 'canonical'));
    expect((await git.branch()).all).toEqual(branchesBefore);
  });

  it('prior-branch-reject', async () => {
    const projectDir = join(root, 'prior-branch-reject');
    await mkdir(projectDir);
    createTestGitRepo(projectDir);
    const git = simpleGit(projectDir);
    for (const branch of PRIOR_BRANCHES) await git.raw(['branch', branch]);

    await expect(removeWorktree({ projectDir, slug: 'legacy', git })).resolves.toBeUndefined();

    const branches = (await git.branch()).all;
    expect(branches).toEqual(expect.arrayContaining([...PRIOR_BRANCHES]));
    expect(branches).not.toContain(`${SPLITBRIEF_IDENTITY.branchPrefix}legacy`);
  });

  it('store-events', () => {
    addEvent({
      type: 'workflow_started',
      ts: 1_000,
      phase: 'researching',
      feature: 'runtime hard cut',
    });
    addEvent({
      type: 'task_started',
      ts: 2_000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Canonical runtime',
      index: 0,
      total: 1,
      file: 'src/runtime.ts',
      action: 'modify',
    });

    expect(eventsStore.get().events.map((event) => event.type)).toEqual([
      'workflow_started',
      'task_started',
    ]);
    expect(runViewStore.get().briefs.tasks).toEqual([
      {
        id: 'T001',
        title: 'Canonical runtime',
        status: 'in_progress',
        file: 'src/runtime.ts',
        action: 'modify',
      },
    ]);
    expect(runViewStore.get().phase).toBe('implementing');
  });

  it('terminal-handover', () => {
    const calls: string[] = [];
    const rawModes: boolean[] = [];
    const stdin = {
      isRaw: true,
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
      setRawMode: (mode: boolean) => {
        rawModes.push(mode);
        stdin.isRaw = mode;
      },
    };
    const config: TerminalHandoverConfig = {
      fullscreen: true,
      mouse: false,
      sourceStdin: stdin,
    };
    const written: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let suspended = false;

    try {
      suspendTerminalForEditor(config);
      suspended = true;
      resumeTerminalAfterEditor(config);
      suspended = false;
    } finally {
      if (suspended) resumeTerminalAfterEditor(config);
      process.stdout.write = originalWrite;
    }

    expect(calls).toEqual(['pause', 'resume']);
    expect(rawModes).toEqual([false, true]);
    expect(written).toContain(terminalSequences.exitAltBuffer);
    expect(written).toContain(terminalSequences.enterAltBuffer);
  });
});
