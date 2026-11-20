import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import {
  cliDetectionFor,
  failedDiscoveryResult,
  rememberDetectedTools,
} from '#testing/helpers/factories/detection.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { loadRememberedCatalog } from '../../../src/cli/bootstrap/discovery.js';
import { detectionContextsForCurrentConfig } from '../../../src/engine/detection/store-publication.js';
import { registerInitCommand } from '../../../src/cli/commands/init.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { detectionStore } from '../../../src/stores/discovery/detection.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';

it('chooses a remembered crew after refresh fails and checks readiness on Continue', async () => {
  const wasTty = process.stdin.isTTY;
  process.stdin.isTTY = true;
  resetAllStores();
  try {
    await withTempDir('init-remembered-crew', async (projectDir) => {
      const viewport = { cols: 120, rows: 40 };
      const program = new Command();
      const contexts = detectionContextsForCurrentConfig({
        projectDir: realpathSync(projectDir),
        config: loadConfig(projectDir).config,
      });
      const ready = [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')];
      await rememberDetectedTools(projectDir, ready);
      registerInitCommand(program, {
        initStores: async (dir) => {
          configStore.load(dir);
          terminalSizeStore.__testReset(viewport);
          await loadRememberedCatalog(dir);
        },
        renderApp: async (app) => {
          const request = detectionStore.beginRefresh({ contexts });
          const ui = renderFeature(app, viewport);
          const frame = () => stripAnsiStyles(ui.lastFrame());
          const shows = (text: string) => vi.waitFor(() => expect(frame()).toContain(text));
          const focused = (label: string) => shows(`${glyph('liveBar')} ${label}`);
          try {
            await shows('Next: choose your crew.');
            expect(
              detectionStore.publish({ request, result: failedDiscoveryResult(request, 2) }),
            ).toBe(true);
            await shows('Refresh failed · remembered results');
            ui.stdin.write('\u001b[H');
            await focused('Claude crew, Codex review');
            ui.stdin.write('\r');
            await shows('Saved Claude crew, Codex review');
            expect(loadConfig(projectDir).config.reviewer).toMatchObject({
              kind: 'cli',
              tool: 'codex',
            });

            detectionStore.setDetection({
              providers: [],
              cliTools: [
                cliDetectionFor('ready', 'claude-code'),
                cliDetectionFor('unauthenticated', 'codex'),
              ],
            });
            await shows('Unavailable · needs OpenAI Codex CLI');
            const panelTop = () =>
              frame()
                .split('\n')
                .findIndex((row) => row.includes('Set up your crew'));
            const beforeFocus = panelTop();
            ui.stdin.write('\u001b[H');
            await focused('Claude crew, Codex review');
            const selectedPreset = frame()
              .split('\n')
              .find((row) => row.includes(`${glyph('liveBar')} Claude crew, Codex review`));
            expect(selectedPreset).toContain('Unavailable · needs OpenAI Codex CLI');
            expect(panelTop()).toBe(beforeFocus);
            ui.stdin.write('\u001b[F');
            await focused('Continue');
            ui.stdin.write('\r');
            await shows('Choose a ready tool and model for each unavailable seat.');
            expect(frame()).toContain('Set up your crew');

            detectionStore.setDetection({ providers: [], cliTools: ready });
            await shows('⏎ continue');
            ui.stdin.write('\r');
            await shows('Describe your feature');
          } finally {
            ui.unmount();
          }
        },
      });
      await program.parseAsync(['init', '--project', projectDir], { from: 'user' });
    });
  } finally {
    process.stdin.isTTY = wasTty;
    resetAllStores();
  }
});
