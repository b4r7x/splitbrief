import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

const VIEWPORT = { cols: 100, rows: 30 };

it.for([true, false])(
  'deletes one character per backspace byte of one terminal read and the word after the caret on Ctrl+Delete, fullscreen=%s',
  async (fullscreen, context) => {
    await withTempDir('composer-backspace-run', async (dir) => {
      const home = join(dir, 'home');
      const projectDir = join(dir, 'project');
      const binDir = join(dir, 'bin');
      mkdirSync(home);
      mkdirSync(binDir);
      mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
      mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
      writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      const runnerPath = join(dir, 'runner.mjs');
      writeFileSync(runnerPath, "throw new Error('No workflow may start in the backspace E2E');\n");
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
      const offlinePath = join(dir, 'offline.mjs');
      writeFileSync(
        offlinePath,
        "globalThis.fetch = async () => { throw new Error('Offline backspace E2E'); };\n",
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
          argv: [
            '--import',
            'tsx',
            '--import',
            offlinePath,
            'src/cli.ts',
            '--project',
            projectDir,
            ...(fullscreen ? [] : ['--no-fullscreen']),
          ],
          spawnOptions: {
            name: 'xterm-256color',
            ...VIEWPORT,
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: { ...environment, XDG_STATE_HOME: join(dir, 'state') },
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
          const screen = () =>
            Array.from(
              { length: VIEWPORT.rows },
              (_, row) =>
                terminal.buffer.active
                  .getLine(terminal.buffer.active.viewportY + row)
                  ?.translateToString(true) ?? '',
            ).join('\n');
          const dataListener = child.onData((data) => terminal.write(data));
          const exitListener = child.onExit((event) => {
            didExit = true;
            exited.resolve(event);
          });
          const showsDraft = async (draft: string) => {
            await vi.waitFor(
              () => {
                const line = screen()
                  .split('\n')
                  .find((row) => row.includes('draft'));
                expect(line?.match(/draft\S*/)?.[0], screen()).toBe(draft);
              },
              { timeout: 10_000 },
            );
          };
          try {
            await vi.waitFor(() => expect(screen()).toContain('Describe your feature'), {
              timeout: 30_000,
            });
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);
            child.write('draft-xyz');
            await showsDraft('draft-xyz');
            child.write('\x7f\x7f');
            await showsDraft('draft-x');
            child.write('\x7f\x7fQ');
            await showsDraft('draftQ');
            child.write(' one two');
            await vi.waitFor(() => expect(screen()).toContain('draftQ one two'), {
              timeout: 10_000,
            });
            for (let step = 0; step < ' one two'.length; step++) child.write('\x1b[D');
            child.write('\x1b[3;5~\x05');
            await vi.waitFor(() => expect(screen()).toContain('draftQ two'), { timeout: 10_000 });

            child.write('\x03');
            await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
            child.write('\x03');
            await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 5_000 });
            expect(await exited.promise).toMatchObject({ exitCode: 0 });
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
      if (result) context.skip(result.reason);
    });
  },
);
