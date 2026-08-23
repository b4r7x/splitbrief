import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { routerStore } from '../../stores/navigation/router.js';
import { registerInitCommand } from './init.js';

vi.mock('../init-stores.js', () => ({ initStores: vi.fn(async () => {}) }));
vi.mock('../render/app.js', () => ({ renderApp: vi.fn(async () => {}) }));

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
      registerInitCommand(program);

      await program.parseAsync(['init', '--project', projectDir], { from: 'user' });

      expect(routerStore.get()).toMatchObject({ screen: 'setup', onComplete: 'home' });
    });
  });
});
