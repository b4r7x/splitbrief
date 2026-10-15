import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir, withTempDir } from '#testing/helpers/temp-dir.js';
import { configPath } from '../../core/config/load/document.js';
import { loadConfig } from '../../core/config/load/io.js';
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
