import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import {
  cacheIdentity,
  catalogState,
  MODELS_DEV_CATALOG_URL,
  persistSnapshot,
} from '../../../src/engine/providers/models-dev/store.js';
import { terminalSequences } from '../../../src/lib/terminal/control.js';
import { stripTerminalControls } from '../../../src/utils/display-text/sanitize.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

it('omits model mode prices from the catalog cache on startup', async (context) => {
  await withTempDir('home-catalog-refresh', async (dir) => {
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    mkdirSync(home);
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: '/usr/bin/true' },
        implementer: { kind: 'agent', command: '/usr/bin/true', model: 'fixture' },
      }),
    );
    const provider = { body: { service_tier: 'priority' } };
    const catalog = {
      openai: {
        id: 'openai',
        models: {
          fixture: {
            id: 'fixture',
            experimental: { modes: { fast: { provider, cost: { input: 2.5, output: 20 } } } },
          },
        },
      },
    };
    const preload = join(dir, 'catalog.mjs');
    writeFileSync(
      preload,
      `globalThis.fetch = async (url) => {
        if (String(url) !== ${JSON.stringify(MODELS_DEV_CATALOG_URL)}) throw new Error('Unexpected fetch');
        return Response.json(${JSON.stringify(catalog)});
      };`,
    );
    const { cachePath } = cacheIdentity({ cacheDir: join(home, SPLITBRIEF_DIR, 'cache') });
    const result = await runWithPtyChild(
      {
        requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
        argv: ['--import', 'tsx', '--import', preload, 'src/cli.ts', '--project', projectDir],
        spawnOptions: {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: { ...safeChildEnvironment(home), XDG_STATE_HOME: join(dir, 'state') },
        },
      },
      async (child) => {
        const exited = Promise.withResolvers<PtyExitEvent>();
        let output = '';
        const dataListener = child.onData((data) => {
          output += data;
        });
        const exitListener = child.onExit(exited.resolve);
        try {
          await vi.waitFor(() => expect(existsSync(cachePath), output).toBe(true), {
            timeout: 20_000,
          });
          expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toHaveProperty(
            'catalog.openai.models.fixture.experimental.modes.fast',
            { provider },
          );
        } finally {
          try {
            await terminatePtyProcessGroup(child, exited.promise);
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

it('handles the first key and quits the real CLI while the cache parser and the tool checks remain held', async (context) => {
  await withTempDir('home-boot-quit', async (dir) => {
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    const childTmp = join(dir, 't');
    const statusLaunches = join(dir, 'status-launches');
    const startedPath = join(dir, 'parse-started');
    const releasePath = join(dir, 'release-parse');
    const finishedPath = join(dir, 'parse-finished');
    mkdirSync(join(home, '.commandcode'), { recursive: true });
    writeFileSync(join(home, '.commandcode', 'auth.json'), '{"apiKey":"fixture"}\n');
    mkdirSync(binDir);
    mkdirSync(childTmp);
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
    // Command Code answers its version, then never answers its sign-in status: the quit comes
    // while both lanes check it, each with a copy of the sign-in file.
    writeFakeNodeCli(
      binDir,
      CLI_TOOL_CATALOG['command-code'].command,
      [
        "const { appendFileSync } = require('node:fs');",
        "if (process.argv.includes('--version')) { console.log('" +
          CLI_TOOL_CATALOG['command-code'].compatibility.testedVersion +
          "'); process.exit(0); }",
        "if (process.argv[2] !== 'status') process.exit(1);",
        `appendFileSync(${JSON.stringify(statusLaunches)}, 'status\\n');`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );

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
      environment = safeChildEnvironment(home, [binDir]);
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
            TMPDIR: childTmp,
            TEMP: childTmp,
            TMP: childTmp,
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
              expect(existsSync(statusLaunches) ? readFileSync(statusLaunches, 'utf8') : '').toBe(
                'status\nstatus\n',
              );
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
          expect(readdirSync(childTmp).filter((name) => /^(splitbrief-|sb-)/.test(name))).toEqual(
            [],
          );
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
