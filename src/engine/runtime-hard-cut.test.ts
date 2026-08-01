import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { expect, it } from 'vitest';
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
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { addEvent } from '../stores/workflow/actions/event.js';
import { resetWorkflow } from '../stores/workflow/actions/reset.js';
import { tasksStore } from '../stores/workflow/tasks.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { loadDetectionCache, saveDetectionCache } from './detection/cache.js';
import { detectCapabilities } from './providers/capabilities.js';
import { createWorktree } from './worktree/create.js';
import { removeWorktree } from './worktree/remove.js';

const EXPECTED_LABELS = [
  'state-write',
  'prior-state-ignore',
  'env-read',
  'prior-env-ignore',
  'branch-create',
  'prior-branch-reject',
  'store-events',
  'terminal-handover',
] as const;

const PRIOR_STATE_DIRS = [
  '.diptych', // brand-contract-negative
  '.tiny-spec', // brand-contract-negative
] as const;
const PRIOR_CONTEXT_ENV_KEYS = [
  'DIPTYCH_CONTEXT_LENGTH', // brand-contract-negative
  'TINY_SPEC_CONTEXT_LENGTH', // brand-contract-negative
] as const;
const PRIOR_BRANCHES = [
  'diptych/legacy', // brand-contract-negative
  'tiny-spec/legacy', // brand-contract-negative
] as const;

it('runtime hard-cut matrix has exactly 8 labeled cases', async () => {
  const root = await mkdtemp(join(tmpdir(), `${SPLITBRIEF_IDENTITY.slug}-runtime-hard-cut-`));
  const canonicalContextEnv = `${SPLITBRIEF_IDENTITY.envPrefix}CONTEXT_LENGTH`;
  const touchedEnvKeys = [canonicalContextEnv, ...PRIOR_CONTEXT_ENV_KEYS];
  const originalEnv = new Map(touchedEnvKeys.map((key) => [key, process.env[key]]));

  const cases = [
    {
      label: 'state-write',
      run: async () => {
        const projectDir = join(root, 'state-write');
        await mkdir(projectDir);

        await saveDetectionCache(projectDir, [], []);

        const cachePath = join(projectDir, SPLITBRIEF_DIR, 'detection-cache.json');
        expect(existsSync(cachePath)).toBe(true);
        expect(await loadDetectionCache(projectDir, 60_000)).toEqual({
          providers: [],
          cliTools: [],
        });
        for (const priorDir of PRIOR_STATE_DIRS) {
          expect(existsSync(join(projectDir, priorDir))).toBe(false);
        }
      },
    },
    {
      label: 'prior-state-ignore',
      run: async () => {
        const projectDir = join(root, 'prior-state-ignore');
        const cache = JSON.stringify({
          version: 1,
          timestamp: Date.now(),
          planners: [],
          implementers: [],
        });
        for (const priorDir of PRIOR_STATE_DIRS) {
          const priorPath = join(projectDir, priorDir, 'detection-cache.json');
          await mkdir(join(projectDir, priorDir), { recursive: true });
          await writeFile(priorPath, cache);
        }

        expect(await loadDetectionCache(projectDir, 60_000)).toBeNull();
        expect(existsSync(join(projectDir, SPLITBRIEF_DIR))).toBe(false);
        for (const priorDir of PRIOR_STATE_DIRS) {
          expect(await readFile(join(projectDir, priorDir, 'detection-cache.json'), 'utf8')).toBe(
            cache,
          );
        }
      },
    },
    {
      label: 'env-read',
      run: async () => {
        process.env[canonicalContextEnv] = '4096';
        for (const key of PRIOR_CONTEXT_ENV_KEYS) delete process.env[key];

        const result = await detectCapabilities(
          makeConfig({ implementer: { contextLength: 16_384 } }),
        );

        expect(result).toEqual({ contextLength: 4096, origin: 'env' });
      },
    },
    {
      label: 'prior-env-ignore',
      run: async () => {
        delete process.env[canonicalContextEnv];
        for (const key of PRIOR_CONTEXT_ENV_KEYS) process.env[key] = '4096';

        const result = await detectCapabilities(
          makeConfig({ implementer: { contextLength: 16_384 } }),
        );

        expect(result).toEqual({ contextLength: 16_384, origin: 'config' });
      },
    },
    {
      label: 'branch-create',
      run: async () => {
        const projectDir = join(root, 'branch-create');
        await mkdir(projectDir);
        createTestGitRepo(projectDir);
        const git = simpleGit(projectDir);

        const worktree = await createWorktree({ projectDir, slug: 'canonical', git });

        expect(worktree).toBe(join(projectDir, TREES_DIR, 'canonical'));
        expect((await git.branch()).all).toContain(`${SPLITBRIEF_IDENTITY.branchPrefix}canonical`);
      },
    },
    {
      label: 'prior-branch-reject',
      run: async () => {
        const projectDir = join(root, 'prior-branch-reject');
        await mkdir(projectDir);
        createTestGitRepo(projectDir);
        const git = simpleGit(projectDir);
        for (const branch of PRIOR_BRANCHES) await git.raw(['branch', branch]);

        await expect(
          removeWorktree({ projectDir, slug: 'legacy', git, deleteBranch: true }),
        ).rejects.toThrow('Worktree ".trees/legacy" does not exist.');

        const branches = (await git.branch()).all;
        expect(branches).toEqual(expect.arrayContaining([...PRIOR_BRANCHES]));
        expect(branches).not.toContain(`${SPLITBRIEF_IDENTITY.branchPrefix}legacy`);
      },
    },
    {
      label: 'store-events',
      run: () => {
        resetWorkflow();
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
        expect(tasksStore.get().tasks).toEqual([
          { id: 'T001', title: 'Canonical runtime', status: 'in_progress' },
        ]);
        expect(lifecycleStore.get().phase).toBe('implementing');
      },
    },
    {
      label: 'terminal-handover',
      run: () => {
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
      },
    },
  ] satisfies ReadonlyArray<{
    label: (typeof EXPECTED_LABELS)[number];
    run: () => void | Promise<void>;
  }>;

  try {
    expect(cases).toHaveLength(8);
    expect(cases.map((entry) => entry.label)).toEqual(EXPECTED_LABELS);
    for (const entry of cases) await entry.run();
  } finally {
    resetWorkflow();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
