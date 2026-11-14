import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { resolveTheme } from '../../../src/core/theme/resolve.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { readForegroundAtText } from '../helpers/terminal-cells.js';

const VIEWPORT = { cols: 120, rows: 40 };
const SCREEN_THEME = resolveTheme({ variant: 'dark', level: 3, terminalBackground: undefined });
// A reason holds 60 ms per character, so the long name keeps it up for every step below. The name
// still fits one composer row, so the screen can show the whole line before Enter goes.
const TYPED = `/setings${'x'.repeat(80)}`;
// Settings wraps the long name onto its own row, so the read takes the words before it.
const REASON_HEAD = 'Unknown command:';
const SETTINGS_KEY = '\u001B[44;5u';

describe('e2e: a refused command that is still on hold in Settings', { timeout: 120_000 }, () => {
  it('shows the reason in the same neutral ink as on home', async (context) => {
    const skipped = await withTempDir('settings-refusal-hold', async (dir) => {
      const home = join(dir, 'home');
      const stateHome = join(dir, 'state');
      const projectDir = join(dir, 'project');
      const binDir = join(dir, 'bin');
      mkdirSync(binDir);
      mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
      mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
      writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      const runnerPath = join(dir, 'runner.mjs');
      writeFileSync(
        runnerPath,
        "throw new Error('No workflow may start in the refusal hold E2E');\n",
      );
      writeConfig(
        projectDir,
        makeConfig({
          planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
          implementer: {
            kind: 'shell',
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
      const offlinePath = join(dir, 'offline.mjs');
      writeFileSync(
        offlinePath,
        "globalThis.fetch = async () => { throw new Error('Offline refusal hold E2E'); };\n",
      );

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
          argv: ['--import', 'tsx', '--import', offlinePath, 'src/cli.ts', '--project', projectDir],
          spawnOptions: {
            name: 'xterm-256color',
            ...VIEWPORT,
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: { ...environment, XDG_STATE_HOME: stateHome },
          },
        },
        async (child) => {
          const terminal = new XtermHeadless.Terminal({
            ...VIEWPORT,
            allowProposedApi: true,
            logLevel: 'off',
          });
          const exited = Promise.withResolvers<PtyExitEvent>();
          let didExit = false;
          const text = () =>
            Array.from(
              { length: VIEWPORT.rows },
              (_, row) =>
                terminal.buffer.active
                  .getLine(terminal.buffer.active.viewportY + row)
                  ?.translateToString(true) ?? '',
            ).join('\n');
          const shows = (expected: string, timeout = 10_000) =>
            vi.waitFor(() => expect(text()).toContain(expected), { timeout });
          const dataListener = child.onData((data) => terminal.write(data));
          const exitListener = child.onExit((event) => {
            didExit = true;
            exited.resolve(event);
          });
          try {
            await shows('Describe your feature', 30_000);
            child.write(TYPED);
            await shows(TYPED);
            child.write('\r');
            await shows(REASON_HEAD);
            const onHome = readForegroundAtText(terminal.buffer.active, REASON_HEAD);
            expect(onHome).toEqual({ mode: 'rgb', color: SCREEN_THEME.textDim });

            child.write(SETTINGS_KEY);
            await shows('esc close');
            await shows(REASON_HEAD);
            expect(text().split(REASON_HEAD)).toHaveLength(2);
            expect(readForegroundAtText(terminal.buffer.active, REASON_HEAD)).toEqual(onHome);
          } finally {
            try {
              if (!didExit) await terminatePtyProcessGroup(child, exited.promise);
            } finally {
              dataListener.dispose();
              exitListener.dispose();
              terminal.dispose();
            }
          }
        },
      );
      return result?.reason;
    });
    if (skipped !== undefined) context.skip(skipped);
  });
});
