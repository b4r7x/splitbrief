import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir, withTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { configPath } from '../../core/config/load/document.js';
import { loadConfig } from '../../core/config/load/io.js';
import { installDiagnosticSink } from '../../lib/warn.js';
import { registerInitCommand } from './init.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function init(projectDir: string, extra: string[] = []) {
  const program = new Command();
  program.exitOverride();
  registerInitCommand(program);
  return program.parseAsync(['init', '--yes', '--project', projectDir, ...extra], { from: 'user' });
}

describe('init --yes detected crew', () => {
  it('saves Codex, keeps an existing config, and reconfigures through detection', async () => {
    await withTempDir('init-detected-crew', async (projectDir) => {
      const shimDir = createTempDir('init-codex-shim');
      const restore = activateCompatibleCliShim(
        installCompatibleCliShim({
          directory: shimDir,
          tool: 'codex',
          authChannel: 'session',
        }),
      );
      vi.stubEnv('PATH', `${shimDir}:/usr/bin:/bin`);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('Offline fixture');
        }),
      );
      const notice = vi.spyOn(console, 'error').mockImplementation(() => {});
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await init(projectDir);
        const config = loadConfig(projectDir).config;
        expect(config.planner).toEqual({ kind: 'cli', tool: 'codex' });
        expect(config.implementer).toEqual({ kind: 'cli', tool: 'codex' });
        expect(notice.mock.calls).toEqual([
          ['No config found. Saved a ready crew to .splitbrief/config.yaml.'],
          ['Added .splitbrief/ to .gitignore.'],
        ]);
        expect(output.mock.calls).toEqual([
          ['Run `splitbrief doctor` to check readiness before your first run.'],
        ]);
        const original = `${readFileSync(configPath(projectDir), 'utf8')}# keep this comment\n`;
        writeFileSync(configPath(projectDir), original);
        await init(projectDir);
        expect(readFileSync(configPath(projectDir), 'utf8')).toBe(original);
        expect(notice).toHaveBeenCalledTimes(2);
        writeFileSync(
          configPath(projectDir),
          '# previous crew\nversion: 3\n42: retained\nplanner:\n  kind: cli\n  tool: claude-code\nworkflow:\n  approve: none\n',
        );
        await init(projectDir, ['--reconfigure']);
        expect(loadConfig(projectDir).config).toEqual(config);
        expect(readFileSync(configPath(projectDir), 'utf8')).not.toMatch(/previous crew|retained/);
        expect(notice).toHaveBeenCalledTimes(3);
        expect(notice).toHaveBeenLastCalledWith('Saved a ready crew to .splitbrief/config.yaml.');
        expect(readFileSync(join(projectDir, '.gitignore'), 'utf8')).toBe('.splitbrief/\n');
      } finally {
        vi.unstubAllEnvs();
        restore();
        cleanupTempDir(shimDir);
      }
    });
  });

  it('leaves config absent and names setup when no tools are ready', async () => {
    await withTempDir('init-no-ready-tools', async (projectDir) => {
      vi.stubEnv('PATH', '/usr/bin:/bin');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('Offline fixture');
        }),
      );
      const notice = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(init(projectDir)).rejects.toThrow(
        'No config found and no ready crew is available. Run splitbrief init',
      );
      expect(existsSync(configPath(projectDir))).toBe(false);
      expect(notice).not.toHaveBeenCalled();
      mkdirSync(join(projectDir, '.splitbrief'));
      const existing = 'version: 3\nworkflow:\n  approve: none\n';
      writeFileSync(configPath(projectDir), existing);
      await expect(init(projectDir, ['--reconfigure'])).rejects.toThrow(
        'No ready crew is available. Run splitbrief init',
      );
      expect(readFileSync(configPath(projectDir), 'utf8')).toBe(existing);
      expect(notice).not.toHaveBeenCalled();
    });
  });
});

describe('init --yes diagnostics', () => {
  it('writes a --project warning for a folder inside the repository as it comes', async () => {
    await withTempDir('init-yes-project-subdir', async (dir) => {
      const projectDir = realpathSync(dir);
      createTestGitRepo(projectDir);
      const subdir = join(projectDir, 'pkg');
      mkdirSync(subdir);
      const shimDir = createTempDir('init-yes-subdir-shim');
      const restore = activateCompatibleCliShim(
        installCompatibleCliShim({ directory: shimDir, tool: 'codex', authChannel: 'session' }),
      );
      vi.stubEnv('PATH', `${shimDir}:/usr/bin:/bin`);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('Offline fixture');
        }),
      );
      const output: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        output.push(String(chunk));
        return true;
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation((line: string) => {
        output.push(line);
      });
      try {
        await init(subdir);
      } finally {
        restore();
        cleanupTempDir(shimDir);
      }

      expect(output[0]).toBe(
        `Warning: --project ${subdir} is inside git repository ${projectDir}; using repository root.\n`,
      );
      expect(output.at(-1)).toBe(
        'Run `splitbrief doctor` to check readiness before your first run.',
      );
    });
  });
});

describe('init on the setup screen', () => {
  it('shows a --project warning for a folder inside the repository once, on the screen', async () => {
    await withTempDir('init-project-subdir', async (dir) => {
      const projectDir = realpathSync(dir);
      createTestGitRepo(projectDir);
      const subdir = join(projectDir, 'pkg');
      mkdirSync(subdir);
      const wasTty = process.stdin.isTTY;
      process.stdin.isTTY = true;
      const writes: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
      const shown: string[] = [];
      const warning = `Warning: --project ${subdir} is inside git repository ${projectDir}; using repository root.`;
      const program = new Command();
      program.exitOverride();
      registerInitCommand(program, {
        initStores: async () => {},
        renderApp: async () => {
          const release = installDiagnosticSink((message) => shown.push(message));
          try {
            expect(writes).toEqual([]);
          } finally {
            release();
          }
        },
      });

      try {
        await program.parseAsync(['init', '--project', subdir], { from: 'user' });
      } finally {
        process.stdin.isTTY = wasTty;
      }

      expect(shown).toEqual([warning]);
      expect(writes).toEqual([`${warning}\n`]);
    });
  });
});
