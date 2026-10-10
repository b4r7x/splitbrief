import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import {
  cacheIdentity,
  catalogState,
  persistSnapshot,
} from '../../../src/engine/providers/models-dev-cache/store.js';
import { terminalSequences } from '../../../src/lib/terminal/control.js';
import { stripTerminalControls } from '../../../src/utils/display-text.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

it('handles the first key and quits the real CLI while the cache parser remains held', async (context) => {
  await withTempDir('home-boot-quit', async (dir) => {
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    const startedPath = join(dir, 'parse-started');
    const releasePath = join(dir, 'release-parse');
    const finishedPath = join(dir, 'parse-finished');
    mkdirSync(home);
    mkdirSync(binDir);
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const runnerPath = join(dir, 'runner.mjs');
    writeFileSync(runnerPath, "throw new Error('No workflow may start in the home boot E2E');\n");
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
        implementer: {
          kind: 'agent',
          command: process.execPath,
          args: [runnerPath],
          model: 'fixture',
        },
        workflow: { isolation: 'none' },
      }),
    );
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
    }

    const identity = cacheIdentity({ cacheDir: join(home, SPLITBRIEF_DIR, 'cache') });
    const catalog = {
      openai: { id: 'openai', models: { fixture: { id: 'fixture', limit: { context: 128_000 } } } },
    };
    const now = Date.now();
    await persistSnapshot(identity, {
      sourceUrl: identity.sourceUrl,
      parserVersion: identity.parserVersion,
      catalog,
      catalogState: catalogState(catalog),
      fetchedAt: now,
      validatedAt: now,
    });

    const restorePath = activateSafeCliShimPath(binDir);
    let environment: Readonly<Record<string, string>>;
    try {
      environment = safeChildEnvironment(home);
    } finally {
      restorePath();
    }
    const result = await runWithPtyChild(
      {
        requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
        argv: [
          '--import',
          'tsx',
          '--import',
          fileURLToPath(new URL('./home-boot-preload.mjs', import.meta.url)),
          'src/cli.ts',
          '--project',
          projectDir,
        ],
        spawnOptions: {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: {
            ...environment,
            XDG_STATE_HOME: join(dir, 'state'),
            SPLITBRIEF_E2E_PARSE_STARTED: startedPath,
            SPLITBRIEF_E2E_PARSE_RELEASE: releasePath,
            SPLITBRIEF_E2E_PARSE_FINISHED: finishedPath,
          },
        },
      },
      async (child) => {
        const exited = Promise.withResolvers<PtyExitEvent>();
        let didExit = false;
        let rawIo = '';
        const exitListener = child.onExit((event) => {
          didExit = true;
          exited.resolve(event);
        });
        const dataListener = child.onData((data) => {
          rawIo += data;
        });
        try {
          await vi.waitFor(
            () => {
              expect(existsSync(startedPath), rawIo).toBe(true);
              expect(stripTerminalControls(rawIo), rawIo).toContain('Describe your feature');
            },
            { timeout: 20_000 },
          );
          expect(didExit).toBe(false);
          expect(rawIo).toContain(terminalSequences.enterAltBuffer);
          child.write('\x03');
          await vi.waitFor(() =>
            expect(stripTerminalControls(rawIo), rawIo).toContain('Press ctrl+c again to quit'),
          );
          expect(existsSync(releasePath)).toBe(false);
          expect(existsSync(finishedPath)).toBe(false);
          expect(didExit).toBe(false);

          const quitAt = performance.now();
          child.write('\x03');
          await vi.waitFor(() => expect(didExit, rawIo).toBe(true), { timeout: 3_000 });
          expect(await exited.promise).toMatchObject({ exitCode: 0 });
          expect(performance.now() - quitAt).toBeLessThan(3_000);
          expect(existsSync(releasePath)).toBe(false);
          expect(existsSync(finishedPath)).toBe(false);
          expect(rawIo.lastIndexOf(terminalSequences.exitAltBuffer)).toBeGreaterThan(
            rawIo.lastIndexOf(terminalSequences.enterAltBuffer),
          );
          expect(rawIo.lastIndexOf(terminalSequences.showCursor)).toBeGreaterThan(
            rawIo.lastIndexOf(terminalSequences.hideCursor),
          );
          expect(existsSync(join(projectDir, '.git', 'index'))).toBe(false);
        } finally {
          try {
            if (!didExit) await terminatePtyProcessGroup(child, exited.promise);
          } finally {
            dataListener.dispose();
            exitListener.dispose();
          }
        }
      },
    );
    if (result) context.skip(result.reason);
  });
});
