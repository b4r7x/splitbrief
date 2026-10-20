import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, withTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  cli,
  createStopContinueFixture,
  escapingImplementerScript,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const DRAFT = 'keep the scanner screen as it is';

describe('e2e: a command taken from the palette over a typed home draft', {
  timeout: 120_000,
}, () => {
  it.for([
    { action: 'cleared', cols: 80, rows: 24 },
    { action: 'cleared by a held Backspace', cols: 80, rows: 24 },
    { action: 'picked again over typed text', cols: 80, rows: 24 },
    { action: 'sent', cols: 80, rows: 24 },
    { action: 'sent', cols: 120, rows: 40 },
  ] as const)(
    'brings the whole draft back once /crew is $action at $cols columns',
    async ({ action, ...viewport }, context) => {
      await withTempDir('palette-prefill-draft', async (dir) => {
        const home = join(dir, 'home');
        const projectDir = join(dir, 'project');
        const binDir = join(dir, 'bin');
        mkdirSync(home);
        mkdirSync(binDir);
        mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
        mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
        writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        const runnerPath = join(dir, 'runner.mjs');
        writeFileSync(
          runnerPath,
          "throw new Error('No workflow may start in the palette prefill E2E');\n",
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
          "globalThis.fetch = async () => { throw new Error('Offline palette prefill E2E'); };\n",
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
            ],
            spawnOptions: {
              name: 'xterm-256color',
              ...viewport,
              cwd: fileURLToPath(new URL('../../../', import.meta.url)),
              env: { ...environment, XDG_STATE_HOME: join(dir, 'state') },
            },
          },
          async (child) => {
            const terminal = new XtermHeadless.Terminal({
              ...viewport,
              allowProposedApi: true,
              logLevel: 'off',
            });
            const exited = Promise.withResolvers<PtyExitEvent>();
            let didExit = false;
            const text = () =>
              Array.from(
                { length: viewport.rows },
                (_, row) =>
                  terminal.buffer.active
                    .getLine(terminal.buffer.active.viewportY + row)
                    ?.translateToString(true) ?? '',
              ).join('\n');
            const shows = (expected: string | RegExp, timeout = 10_000) =>
              vi.waitFor(
                () =>
                  typeof expected === 'string'
                    ? expect(text()).toContain(expected)
                    : expect(text()).toMatch(expected),
                { timeout },
              );
            const dataListener = child.onData((data) => terminal.write(data));
            const exitListener = child.onExit((event) => {
              didExit = true;
              exited.resolve(event);
            });
            try {
              await shows('Describe your feature', 30_000);
              await delay(PROMPT_TYPEAHEAD_GRACE_MS);

              child.write(DRAFT);
              await shows(`› ${DRAFT}`);
              const pickCrew = async () => {
                child.write('\x0b');
                await shows('Type a command…');
                child.write('crew');
                await shows(/▌ \/crew/);
                child.write('\r');
                await shows(/│ › \/crew\s+│/);
              };
              await pickCrew();
              expect(text()).not.toContain(DRAFT);

              if (action === 'picked again over typed text') {
                child.write('plan now');
                await shows('› /crew plan now');
                await pickCrew();
                expect(text()).not.toContain('plan now');
              }
              if (action === 'cleared' || action === 'picked again over typed text') {
                for (let i = 0; i < '/crew '.length; i++) {
                  child.write('\x7f');
                  await delay(50);
                }
              } else if (action === 'cleared by a held Backspace') {
                // Key repeat: more presses than the command has characters, at the repeat rate.
                for (let i = 0; i < '/crew '.length * 2; i++) {
                  child.write('\x7f');
                  await delay(33);
                }
                await delay(300);
              } else {
                child.write('\r');
                await shows('PLAN · tool, model, effort');
                child.write('\x1b');
              }

              // A delete leaves the caret at the draft's start: its cell paints before the text.
              await shows(action === 'sent' ? `› ${DRAFT}` : `›  ${DRAFT}`);
              expect(text()).not.toMatch(/› \/crew/);
              if (action === 'picked again over typed text') {
                await shows(/│\s+\/crew plan now\s+│/);
              }
              if (action === 'cleared by a held Backspace') {
                child.write('x');
                await shows(`› x ${DRAFT}`);
              }
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
});

describe('e2e: a typed home draft while a run is opened from the recent sessions', {
  timeout: 180_000,
}, () => {
  const viewport = { cols: 100, rows: 30 };
  let fixture: StopContinueFixture | undefined;

  afterEach(() => {
    if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
    fixture = undefined;
  });

  it.for([{ held: false }, { held: true }] as const)(
    'brings the draft back on home after the run is left (command held: $held)',
    async ({ held }, context) => {
      fixture = createStopContinueFixture(escapingImplementerScript);
      const target = fixture;
      const halted = await cli(target, ['start', 'smoke']);
      expect(halted.exitCode, halted.stderr).toBe(1);

      const home = join(target.tmpDir, 'home');
      const binDir = join(target.tmpDir, 'bin');
      mkdirSync(home);
      mkdirSync(binDir);
      for (const tool of Object.values(CLI_TOOL_CATALOG)) {
        writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
      }
      const offlinePath = join(target.tmpDir, 'offline.mjs');
      writeFileSync(
        offlinePath,
        "globalThis.fetch = async () => { throw new Error('Offline home draft E2E'); };\n",
      );
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
            target.projectDir,
          ],
          spawnOptions: {
            name: 'xterm-256color',
            ...viewport,
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: { ...safeChildEnvironment(home, [binDir]), XDG_STATE_HOME: target.stateHome },
          },
        },
        async (child) => {
          const terminal = new XtermHeadless.Terminal({
            ...viewport,
            allowProposedApi: true,
            logLevel: 'off',
          });
          const exited = Promise.withResolvers<PtyExitEvent>();
          let didExit = false;
          const text = () =>
            Array.from(
              { length: viewport.rows },
              (_, row) =>
                terminal.buffer.active
                  .getLine(terminal.buffer.active.viewportY + row)
                  ?.translateToString(true) ?? '',
            ).join('\n');
          const shows = (expected: string | RegExp, timeout = 10_000) =>
            vi.waitFor(
              () =>
                typeof expected === 'string'
                  ? expect(text()).toContain(expected)
                  : expect(text()).toMatch(expected),
              { timeout },
            );
          const dataListener = child.onData((data) => terminal.write(data));
          const exitListener = child.onExit((event) => {
            didExit = true;
            exited.resolve(event);
          });
          try {
            await shows('Describe your feature', 30_000);
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);

            child.write(DRAFT);
            await shows(`› ${DRAFT}`);
            if (held) {
              child.write('\x0b');
              await shows('Type a command…');
              child.write('crew');
              await shows(/▌ \/crew/);
              child.write('\r');
              await shows(/│ › \/crew\s+│/);
              expect(text()).not.toContain(DRAFT);
            }

            child.write('\x12');
            await shows('↑↓ select · ⏎ open');
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);
            child.write('\r');
            await shows('Needs you');
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);

            child.write('\x1b');
            await shows('Recent sessions');
            await shows(new RegExp(`│ ›\\s+${DRAFT}\\s+│`));
            expect(text()).not.toMatch(/› \/crew/);
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
    },
  );
});
