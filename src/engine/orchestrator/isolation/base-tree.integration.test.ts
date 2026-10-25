import { execSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { createTestGitRepo, recordGitLaunches } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { runBaseTreesRoot } from '../../../core/paths.js';
import { installDiagnosticSink } from '../../../lib/warn.js';
import { runBaseOf, withRunBaseTree } from './base-tree.js';
import { runBaseTreeError } from './errors.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const FILES = {
  'src/legacy.ts': 'export const legacy = 1;\n',
  'src/legacy.test.ts': "import { legacy } from './legacy.js';\n",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
}

function baseOf(run: ApplyRun) {
  const base = runBaseOf(
    { projectDir: run.dir, sessionId: run.sessionId },
    { workspace: run.workspace },
  );
  if (base === undefined) throw new Error('The run recorded no workspace base');
  return base;
}

/**
 * Commits what a snapshot of file contents cannot carry: an executable script, a symlink and a
 * file under a nested `.splitbrief/` directory. The gate of a real project reads all three.
 */
function commitTreeOnlyEntries(dir: string): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/hook.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'scripts/hook.sh'), 0o755);
  symlinkSync('src/legacy.ts', join(dir, 'legacy-link.ts'));
  mkdirSync(join(dir, 'fixtures/p/.splitbrief'), { recursive: true });
  writeFileSync(join(dir, 'fixtures/p/.splitbrief/config.yaml'), 'version: 3\n');
  git(dir, 'add scripts/hook.sh legacy-link.ts');
  git(dir, 'add -f fixtures/p/.splitbrief/config.yaml');
  git(dir, 'commit -q -m tree-only');
}

describe('withRunBaseTree', { timeout: 60_000 }, () => {
  it('materialises the run base outside the project and the workspace, adds no ref, then removes it', async () => {
    await withApplyRun(
      FILES,
      {
        sessionId: 'sess-base-tree',
        atBase: (dir) => {
          commitTreeOnlyEntries(dir);
          writeFileSync(join(dir, 'scripts/hook.sh'), '#!/bin/sh\necho edited\n');
          // An uncommitted edit the run started from belongs to the run base.
          writeFileSync(join(dir, 'src/legacy.ts'), 'export const legacy = 2;\n');
        },
      },
      async (run) => {
        mkdirSync(join(run.dir, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(run.ws, 'src/legacy.ts'), 'export const legacy = 3;\n');
        writeFileSync(join(run.ws, 'src/added.ts'), 'export const added = 1;\n');
        const refs = git(run.dir, 'for-each-ref');
        const worktrees = git(run.dir, 'worktree list --porcelain');

        const first = git(run.dir, 'rev-parse HEAD~1').trim();

        let tree = '';
        const legacy = await withRunBaseTree(baseOf(run), run.ws, async ({ dir, incomplete }) => {
          tree = dir;
          expect(incomplete).toBeUndefined();
          expect(realpathSync(dir)).toHaveLength(realpathSync(run.ws).length);
          expect(inside(run.dir, dir)).toBe(false);
          expect(inside(run.ws, dir)).toBe(false);
          expect(readFileSync(join(dir, 'src/legacy.test.ts'), 'utf-8')).toBe(
            FILES['src/legacy.test.ts'],
          );
          expect(existsSync(join(dir, 'src/added.ts'))).toBe(false);
          expect(lstatSync(join(dir, 'node_modules')).isSymbolicLink()).toBe(true);
          // A Git checkout of the recorded head, with its history, as the run workspace has.
          expect(git(dir, 'rev-parse HEAD').trim()).toBe(run.workspace.base.head);
          expect(() => git(dir, `cat-file -e ${first}^{commit}`)).not.toThrow();
          expect(git(dir, 'ls-files')).toContain('scripts/hook.sh');
          expect(statSync(join(dir, 'scripts/hook.sh')).mode & 0o111).not.toBe(0);
          expect(readFileSync(join(dir, 'scripts/hook.sh'), 'utf-8')).toContain('echo edited');
          expect(readlinkSync(join(dir, 'legacy-link.ts'))).toBe('src/legacy.ts');
          expect(readFileSync(join(dir, 'fixtures/p/.splitbrief/config.yaml'), 'utf-8')).toBe(
            'version: 3\n',
          );
          expect(git(run.dir, 'for-each-ref')).toBe(refs);
          return readFileSync(join(dir, 'src/legacy.ts'), 'utf-8');
        });

        expect(legacy).toEqual({ result: 'export const legacy = 2;\n', cleanupError: undefined });
        expect(tree).not.toBe('');
        expect(existsSync(tree)).toBe(false);
        expect(git(run.dir, 'for-each-ref')).toBe(refs);
        expect(git(run.dir, 'worktree list --porcelain')).toBe(worktrees);
      },
    );
  });

  it('initialises the submodules of the run base', async () => {
    const subRepo = createTempDir('base-tree-sub');
    createTestGitRepo(subRepo, { 'lib.txt': 'submodule content\n' });
    const prevAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = 'file';
    try {
      await withApplyRun(
        FILES,
        {
          sessionId: 'sess-base-tree-submodule',
          atBase: (dir) => {
            git(dir, `submodule add -q ${JSON.stringify(subRepo)} vendor`);
            git(dir, 'commit -q -m submodule');
          },
        },
        async (run) => {
          const completed = await withRunBaseTree(baseOf(run), run.ws, async ({ dir }) => ({
            head: git(join(dir, 'vendor'), 'rev-parse HEAD').trim(),
            lib: readFileSync(join(dir, 'vendor/lib.txt'), 'utf-8'),
          }));
          expect(completed).toEqual({
            result: { head: git(subRepo, 'rev-parse HEAD').trim(), lib: 'submodule content\n' },
            cleanupError: undefined,
          });
        },
      );
    } finally {
      if (prevAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = prevAllowProtocol;
      cleanupTempDir(subRepo);
    }
  });

  it('passes the user LFS smudge settings to the checkout filter of the run base', async () => {
    const probeDir = createTempDir('base-tree-smudge');
    const probe = join(probeDir, 'smudge.sh');
    const marker = join(probeDir, 'smudge-env');
    writeFileSync(
      probe,
      `#!/bin/sh\nprintf "%s %s\\n" "\${GIT_LFS_SKIP_SMUDGE-unset}" "\${GIT_LFS_SKIP_DOWNLOAD_ERRORS-unset}" >> "${marker}"\ncat\n`,
    );
    chmodSync(probe, 0o755);
    const environment = { GIT_LFS_SKIP_SMUDGE: '1', GIT_LFS_SKIP_DOWNLOAD_ERRORS: '1' };
    const previousEnvironment = new Map(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    try {
      await withApplyRun(
        FILES,
        {
          sessionId: 'sess-base-tree-smudge',
          atBase: (dir) => {
            git(dir, `config filter.probe.smudge ${JSON.stringify(probe)}`);
            git(dir, 'config filter.probe.clean cat');
            writeFileSync(join(dir, '.gitattributes'), '*.bin filter=probe\n');
            writeFileSync(join(dir, 'asset.bin'), 'pointer\n');
            git(dir, 'add .gitattributes asset.bin');
            git(dir, 'commit -q -m lfs');
          },
        },
        async (run) => {
          Object.assign(process.env, environment);
          rmSync(marker, { force: true });
          await withRunBaseTree(baseOf(run), run.ws, async () => undefined);
          const lines = readFileSync(marker, 'utf-8').trim().split('\n');
          expect(lines.length).toBeGreaterThan(0);
          for (const line of lines) expect(line).toBe('1 1');
        },
      );
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      cleanupTempDir(probeDir);
    }
  });

  it('removes the tree when the work inside it throws', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-tree-throws' }, async (run) => {
      const worktrees = git(run.dir, 'worktree list --porcelain');
      let tree = '';
      await expect(
        withRunBaseTree(baseOf(run), run.ws, async ({ dir }) => {
          tree = dir;
          throw new Error('stage crashed');
        }),
      ).rejects.toThrow('stage crashed');
      expect(tree).not.toBe('');
      expect(existsSync(tree)).toBe(false);
      expect(git(run.dir, 'worktree list --porcelain')).toBe(worktrees);
    });
  });

  // C3 review: an unreachable base commit crashed the review and left the base row running.
  it('throws preparationFailed with the Git error when the base commit cannot be checked out, and leaves nothing behind', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-tree-unreachable' }, async (run) => {
      const worktrees = git(run.dir, 'worktree list --porcelain');
      mkdirSync(runBaseTreesRoot(), { recursive: true });
      const before = readdirSync(runBaseTreesRoot());
      const use = vi.fn();
      const failed = await withRunBaseTree(
        { ...baseOf(run), head: 'f'.repeat(40) },
        run.ws,
        use,
      ).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(runBaseTreeError.isPreparationFailed(failed)).toBe(true);
      expect(failed).toHaveProperty(
        'message',
        expect.stringContaining('the run base could not be prepared'),
      );
      expect(failed).toHaveProperty('message', expect.stringContaining('f'.repeat(40)));
      expect(use).not.toHaveBeenCalled();
      expect(readdirSync(runBaseTreesRoot())).toEqual(before);
      expect(git(run.dir, 'worktree list --porcelain')).toBe(worktrees);
    });
  });

  // C3 review: a SIGKILL during a base re-run left its tree and its `.git/worktrees/base-*`
  // registration forever.
  it('removes the base trees of a process that is gone and their registrations, and keeps a live process tree', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-tree-sweep' }, async (run) => {
      mkdirSync(runBaseTreesRoot(), { recursive: true });
      const gone = spawnSync(process.execPath, ['-e', '']).pid;
      const stale = join(runBaseTreesRoot(), `base-${gone}-stale`);
      const live = join(runBaseTreesRoot(), `base-${process.pid}-live`);
      const unowned = join(runBaseTreesRoot(), 'base-unowned');
      const missing = join(run.dir, 'unrelated-missing-worktree');
      git(run.dir, `worktree add --detach ${JSON.stringify(stale)} HEAD`);
      git(run.dir, `worktree add --detach ${JSON.stringify(live)} HEAD`);
      git(run.dir, `worktree add --detach ${JSON.stringify(missing)} HEAD`);
      rmSync(missing, { recursive: true, force: true });
      // Git names a registration after the tree's directory, whatever path form it prints.
      const registered = (tree: string) =>
        existsSync(join(run.dir, '.git', 'worktrees', basename(tree)));
      expect(registered(stale)).toBe(true);
      mkdirSync(unowned);
      const launches = recordGitLaunches();
      try {
        await withRunBaseTree(baseOf(run), run.ws, async () => undefined);

        expect(existsSync(stale)).toBe(false);
        expect(registered(stale)).toBe(false);
        expect(existsSync(live)).toBe(true);
        expect(registered(live)).toBe(true);
        expect(existsSync(unowned)).toBe(true);
        expect(registered(missing)).toBe(true);
        expect(git(run.dir, 'worktree list --porcelain')).toContain(missing);
        expect(launches.launches().some((line) => line.includes('worktree prune'))).toBe(false);
      } finally {
        launches.restore();
        git(run.dir, `worktree remove --force ${JSON.stringify(live)}`);
        git(run.dir, `worktree remove --force ${JSON.stringify(missing)}`);
        rmSync(unowned, { recursive: true, force: true });
      }
    });
  });

  it('sweeps dead-process copies and another repository worktree on a run without a base commit', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-owner' }, async (owner) => {
      await withApplyRun(
        FILES,
        { sessionId: 'sess-base-sweep-no-head', strategy: 'staged-copy' },
        async (run) => {
          expect(run.workspace.base.head).toBeNull();
          mkdirSync(runBaseTreesRoot(), { recursive: true });
          const gone = spawnSync(process.execPath, ['-e', '']).pid;
          const stale = join(runBaseTreesRoot(), `base-${gone}-foreign`);
          const copy = join(runBaseTreesRoot(), `base-${gone}-copy`);
          const older = join(runBaseTreesRoot(), 'base-older-build');
          git(owner.dir, `worktree add --detach ${JSON.stringify(stale)} HEAD`);
          git(owner.dir, `worktree add --detach ${JSON.stringify(older)} HEAD`);
          mkdirSync(copy);
          writeFileSync(join(copy, 'leftover.txt'), 'snapshot-only');
          const registration = join(owner.dir, '.git/worktrees', basename(stale));
          const olderRegistration = join(owner.dir, '.git/worktrees', basename(older));
          expect(existsSync(registration)).toBe(true);
          try {
            await withRunBaseTree(baseOf(run), run.ws, async () => undefined);
            expect(existsSync(stale)).toBe(false);
            expect(existsSync(registration)).toBe(false);
            expect(existsSync(copy)).toBe(false);
            expect(existsSync(older)).toBe(true);
            expect(existsSync(olderRegistration)).toBe(true);
            expect(git(owner.dir, 'worktree list --porcelain')).not.toContain(stale);
          } finally {
            git(owner.dir, `worktree remove --force ${JSON.stringify(older)}`);
          }
        },
      );
    });
  });

  it('warns about a stale tree it cannot remove and still prepares the run base', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-sweep-fails' }, async (run) => {
      mkdirSync(runBaseTreesRoot(), { recursive: true });
      const gone = spawnSync(process.execPath, ['-e', '']).pid;
      const stale = join(runBaseTreesRoot(), `base-${gone}-locked`);
      git(run.dir, `worktree add --detach ${JSON.stringify(stale)} HEAD`);
      git(run.dir, `worktree lock ${JSON.stringify(stale)}`);
      const warnings: string[] = [];
      const restore = installDiagnosticSink((message) => warnings.push(message));
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const completed = await withRunBaseTree(
            { ...baseOf(run), head: null },
            run.ws,
            async ({ dir }) => readFileSync(join(dir, 'src/legacy.ts'), 'utf8'),
          );
          expect(completed).toEqual({ result: FILES['src/legacy.ts'], cleanupError: undefined });
        }
        expect(warnings).toHaveLength(2);
        expect(warnings.every((warning) => warning.includes(stale))).toBe(true);
        expect(warnings.every((warning) => warning.includes('locked'))).toBe(true);
        expect(existsSync(stale)).toBe(true);
        expect(existsSync(join(run.dir, '.git/worktrees', basename(stale)))).toBe(true);
      } finally {
        restore();
        git(run.dir, `worktree unlock ${JSON.stringify(stale)}`);
        git(run.dir, `worktree remove --force ${JSON.stringify(stale)}`);
      }
    });
  });

  it.each(['absolute', 'relative'] as const)(
    'sweeps a stale tree with a missing %s gitdir and runs the current base command',
    async (pathKind) => {
      await withApplyRun(FILES, { sessionId: 'sess-base-owner-gone' }, async (run) => {
        const owner = createTempDir('base-owner-gone');
        createTestGitRepo(owner, FILES);
        mkdirSync(runBaseTreesRoot(), { recursive: true });
        const gone = spawnSync(process.execPath, ['-e', '']).pid;
        const stale = join(runBaseTreesRoot(), `base-${gone}-owner-gone`);
        git(owner, `worktree add --detach ${JSON.stringify(stale)} HEAD`);
        const gitdir = readFileSync(join(stale, '.git'), 'utf8').trim().slice('gitdir: '.length);
        if (pathKind === 'relative') {
          writeFileSync(join(stale, '.git'), `gitdir: ${relative(stale, gitdir)}\n`);
        }
        cleanupTempDir(owner);
        expect(existsSync(gitdir)).toBe(false);
        const worktrees = git(run.dir, 'worktree list --porcelain');
        try {
          const completed = await withRunBaseTree(baseOf(run), run.ws, async ({ dir }) => {
            expect(existsSync(stale)).toBe(false);
            expect(git(dir, 'rev-parse HEAD').trim()).toBe(run.workspace.base.head);
            return readFileSync(join(dir, 'src/legacy.ts'), 'utf8');
          });
          expect(completed).toEqual({ result: FILES['src/legacy.ts'], cleanupError: undefined });
          expect(git(run.dir, 'worktree list --porcelain')).toBe(worktrees);
        } finally {
          rmSync(stale, { recursive: true, force: true });
          cleanupTempDir(owner);
        }
      });
    },
  );

  it.each(['worktree', 'staged-copy'] as const)(
    'wraps a snapshot reconciliation failure and removes the %s base tree',
    async (strategy) => {
      await withApplyRun(FILES, { sessionId: 'sess-base-reconcile', strategy }, async (run) => {
        mkdirSync(runBaseTreesRoot(), { recursive: true });
        const before = readdirSync(runBaseTreesRoot());
        const worktrees = git(run.dir, 'worktree list --porcelain');
        const use = vi.fn();
        const failed = await withRunBaseTree(
          { ...baseOf(run), snapshotId: 'missing-snapshot' },
          run.ws,
          use,
        ).catch((err: unknown) => err);
        expect(runBaseTreeError.isPreparationFailed(failed)).toBe(true);
        expect(failed).toHaveProperty('message', expect.stringContaining('missing-snapshot'));
        expect(use).not.toHaveBeenCalled();
        expect(readdirSync(runBaseTreesRoot())).toEqual(before);
        expect(git(run.dir, 'worktree list --porcelain')).toBe(worktrees);
      });
    },
  );

  it('records cleanup failure alongside the preparation error', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-double-failure' }, async (run) => {
      mkdirSync(runBaseTreesRoot(), { recursive: true });
      const before = readdirSync(runBaseTreesRoot());
      const cleanupError = new Error('base copy removal denied');
      const remove = fs.rm;
      vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
        if (String(path).startsWith(runBaseTreesRoot())) throw cleanupError;
        return remove(path, options);
      });
      try {
        const failed = await withRunBaseTree(
          { ...baseOf(run), head: 'f'.repeat(40) },
          run.ws,
          vi.fn(),
        ).catch((err: unknown) => err);
        expect(runBaseTreeError.isPreparationFailed(failed)).toBe(true);
        expect(failed).toHaveProperty('message', expect.stringContaining('f'.repeat(40)));
        expect(failed).toHaveProperty('message', expect.stringContaining(cleanupError.message));
        expect(failed).toHaveProperty('data.cleanupError', cleanupError);
      } finally {
        vi.restoreAllMocks();
        for (const name of readdirSync(runBaseTreesRoot())) {
          if (!before.includes(name)) rmSync(join(runBaseTreesRoot(), name), { recursive: true });
        }
      }
    });
  });

  it.each(['pass', 'throw'] as const)(
    'reports cleanup failure after the callback chooses to %s',
    async (outcome) => {
      await withApplyRun(FILES, { sessionId: 'sess-base-cleanup-fails' }, async (run) => {
        const warnings: string[] = [];
        const restore = installDiagnosticSink((message) => warnings.push(message));
        const callbackError = new Error('callback failed');
        let tree = '';
        try {
          const completed = await withRunBaseTree(baseOf(run), run.ws, async ({ dir }) => {
            tree = dir;
            git(run.dir, `worktree lock ${JSON.stringify(dir)}`);
            if (outcome === 'throw') throw callbackError;
            return 'passed';
          }).catch((err: unknown) => err);
          if (outcome === 'throw') {
            expect(completed).toBe(callbackError);
            expect(warnings.join('\n')).toContain(tree);
            expect(warnings.join('\n')).toContain('locked');
          } else {
            expect(completed).toMatchObject({
              result: 'passed',
              cleanupError: expect.stringContaining(tree),
            });
            expect(completed).toHaveProperty('cleanupError', expect.stringContaining('locked'));
          }
          expect(existsSync(tree)).toBe(true);
          expect(existsSync(join(run.dir, '.git/worktrees', basename(tree)))).toBe(true);
        } finally {
          restore();
          git(run.dir, `worktree unlock ${JSON.stringify(tree)}`);
          git(run.dir, `worktree remove --force ${JSON.stringify(tree)}`);
        }
      });
    },
  );

  it('matches the workspace path length as a check reads it when the state folder links to a shorter one', async () => {
    await withApplyRun(
      FILES,
      { sessionId: 'sess-base-tree-linked-state', strategy: 'staged-copy' },
      async (run) => {
        const links = createTempDir('base-tree-links');
        mkdirSync(join(links, 's'));
        const state = join(links, `state-${'x'.repeat(40)}`);
        symlinkSync(join(links, 's'), state, 'dir');
        vi.stubEnv('XDG_STATE_HOME', state);
        try {
          const seen = await withRunBaseTree(baseOf(run), run.ws, async ({ dir }) =>
            realpathSync(dir),
          );
          expect(seen.result.startsWith(join(realpathSync(links), 's'))).toBe(true);
          expect(seen.result).toHaveLength(realpathSync(run.ws).length);
        } finally {
          vi.unstubAllEnvs();
          cleanupTempDir(links);
        }
      },
    );
  });

  it('names a base tree no shorter than its owner and random part, and no longer than 255 bytes', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-tree-name-bounds' }, async (run) => {
      const nameFor = async (workspaceDir: string) =>
        (await withRunBaseTree(baseOf(run), workspaceDir, async ({ dir }) => basename(dir))).result;

      expect(await nameFor('/')).toMatch(new RegExp(`^base-${process.pid}-[A-Za-z0-9]{6}$`));
      const deep = join(run.dir, 'w'.repeat(200), 'w'.repeat(200));
      mkdirSync(deep, { recursive: true });
      const longest = await nameFor(deep);
      expect(longest).toMatch(new RegExp(`^base-${process.pid}-_+[A-Za-z0-9]{6}$`));
      expect(Buffer.byteLength(longest)).toBe(255);
    });
  });

  it('names the base a staged-copy run started from, and why its copy is incomplete', async () => {
    await withApplyRun(
      FILES,
      { sessionId: 'sess-base-tree-staged', strategy: 'staged-copy' },
      async (run) => {
        writeFileSync(join(run.ws, 'src/legacy.ts'), 'export const legacy = 9;\n');
        const seen = await withRunBaseTree(baseOf(run), run.ws, async ({ dir, incomplete }) => ({
          length: realpathSync(dir).length,
          legacy: readFileSync(join(dir, 'src/legacy.ts'), 'utf-8'),
          git: existsSync(join(dir, '.git')),
          incomplete,
        }));
        expect(seen.result).toEqual({
          length: realpathSync(run.ws).length,
          legacy: FILES['src/legacy.ts'],
          git: false,
          incomplete:
            'the run recorded no base commit, so its run base copy has no Git history, file modes or symlinks',
        });
        expect(seen.cleanupError).toBeUndefined();
      },
    );
  });
});

describe('runBaseOf', () => {
  it('reads the workspace-base snapshot the run recorded', () => {
    expect(
      runBaseOf(
        { projectDir: '/repo', sessionId: 'sess-1' },
        {
          workspace: {
            kind: 'worktree',
            path: '/state/trees/abc/sess-1',
            base: { snapshotId: 'snap-base', head: 'abc123' },
          },
        },
      ),
    ).toEqual({
      projectDir: '/repo',
      sessionId: 'sess-1',
      snapshotId: 'snap-base',
      head: 'abc123',
    });
  });

  it('has no run base for an older run that recorded no workspace', () => {
    expect(runBaseOf({ projectDir: '/repo', sessionId: 'sess-1' }, {})).toBeUndefined();
  });
});
