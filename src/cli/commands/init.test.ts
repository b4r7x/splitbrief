import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { routerStore } from '../../stores/navigation/router.js';
import { installDiagnosticSink, warnStderr } from '../../lib/warn.js';
import { registerInitCommand } from './init.js';

describe('splitbrief init', () => {
  const wasTty = process.stdin.isTTY;

  beforeEach(() => {
    process.stdin.isTTY = true;
    routerStore.init({ screen: 'home' });
  });

  afterEach(() => {
    process.stdin.isTTY = wasTty;
    vi.restoreAllMocks();
  });

  it('routes the interactive path to the setup screen, completing home', async () => {
    await withTempDir('init-routes-setup', async (projectDir) => {
      const program = new Command();
      program.exitOverride();
      registerInitCommand(program, {
        initStores: vi.fn(async () => {}),
        renderApp: vi.fn(async () => {}),
      });

      await program.parseAsync(['init', '--project', projectDir], { from: 'user' });

      expect(routerStore.get()).toMatchObject({ screen: 'setup', onComplete: 'home' });
    });
  });

  it('shows a warning raised while it starts on the setup screen once the screen mounts', async () => {
    await withTempDir('init-boot-warning', async (projectDir) => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const shown: string[] = [];
      const program = new Command();
      program.exitOverride();
      registerInitCommand(program, {
        initStores: vi.fn(async () => {
          warnStderr('Could not read .splitbrief/ui-prefs.json, so the default layout is used');
        }),
        renderApp: vi.fn(async () => {
          const release = installDiagnosticSink((message) => shown.push(message));
          try {
            expect(stderrSpy).not.toHaveBeenCalled();
          } finally {
            release();
          }
        }),
      });

      await program.parseAsync(['init', '--project', projectDir], { from: 'user' });

      expect(shown).toEqual([
        'Could not read .splitbrief/ui-prefs.json, so the default layout is used',
      ]);
      expect(stderrSpy.mock.calls).toEqual([
        ['Could not read .splitbrief/ui-prefs.json, so the default layout is used\n'],
      ]);
    });
  });
});
