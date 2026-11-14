import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { describe, expect, it, type TestContext, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { moveCursorTo } from '../helpers/move-cursor.js';
import { wholeFrames } from '../helpers/whole-frames.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

const VIEWPORT = { cols: 120, rows: 40 };
const MODELS_VERBOSE = fileURLToPath(
  new URL('../../fixtures/kilo/models-verbose.txt', import.meta.url),
);
// `kilo auth list` on kilo 7.0.49: a Copilot sign-in and an OpenAI key.
const AUTH_LIST =
  '┌  Credentials ~/.local/share/kilo/auth.json\n│\n●  GitHub Copilot oauth\n│\n└  1 credentials\n\n┌  Environment\n│\n●  OpenAI OPENAI_API_KEY\n│\n└  1 environment variables\n';

interface BuildPicker {
  readonly projectDir: string;
  readonly text: () => string;
  readonly write: (keys: string) => void;
  readonly shows: (expected: string | RegExp, timeout?: number) => Promise<void>;
}

/**
 * Starts SPLITBRIEF with the BUILD seat on `openai/gpt-5.5` on Kilo, opens the BUILD seat's
 * picker from Settings and waits for Kilo's listing and the row the picker opens on.
 * With `held`, Kilo answers `models --verbose` only after the picker shows the seat's model row.
 */
async function onBuildPicker(
  context: TestContext,
  held: boolean,
  steps: (picker: BuildPicker) => Promise<void>,
): Promise<void> {
  await withTempDir('kilo-route-identity', async (dir) => {
    const listingGate = join(dir, 'listing-gate');
    if (!held) writeFileSync(listingGate, '');
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const kiloData = join(home, '.local', 'share', 'kilo');
    mkdirSync(kiloData, { recursive: true });
    writeFileSync(join(kiloData, 'auth.json'), '{"github-copilot":{"type":"oauth"}}\n');
    const runnerPath = join(dir, 'runner.mjs');
    writeFileSync(runnerPath, "throw new Error('No workflow may start in the Kilo route E2E');\n");
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
        implementer: { kind: 'cli', tool: 'kilo-code', model: 'openai/gpt-5.5' },
        workflow: { isolation: 'none' },
      }),
    );
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
    }
    writeFakeNodeCli(
      binDir,
      'kilo',
      `const args = process.argv.slice(2).join(' ');
if (args === '--version') {
  console.log('7.0.49');
  process.exit(0);
}
if (args === 'auth list') {
  process.stdout.write(${JSON.stringify(AUTH_LIST)});
  process.exit(0);
}
if (args.startsWith('models --verbose')) {
  const fs = require('node:fs');
  const answer = () => {
    if (!fs.existsSync(${JSON.stringify(listingGate)})) {
      setTimeout(answer, 20);
      return;
    }
    process.stdout.write(fs.readFileSync(${JSON.stringify(MODELS_VERBOSE)}, 'utf8'));
    process.exit(0);
  };
  answer();
} else {
  process.exit(1);
}`,
    );
    const offlinePath = join(dir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('Offline Kilo route E2E'); };\n",
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
        const text = () =>
          Array.from(
            { length: VIEWPORT.rows },
            (_, row) =>
              terminal.buffer.active
                .getLine(terminal.buffer.active.viewportY + row)
                ?.translateToString(true) ?? '',
          ).join('\n');
        const write = (keys: string) => child.write(keys);
        const shows = (expected: string | RegExp, timeout = 10_000) =>
          vi.waitFor(
            () =>
              typeof expected === 'string'
                ? expect(text()).toContain(expected)
                : expect(text()).toMatch(expected),
            { timeout },
          );
        const frames = wholeFrames((data) => terminal.write(data));
        const dataListener = child.onData(frames.feed);
        const exitListener = child.onExit((event) => {
          frames.flush();
          didExit = true;
          exited.resolve(event);
        });
        try {
          await shows('Describe your feature', 30_000);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          write('/crew');
          await shows('▌ /crew  Who fills each seat');
          write('\r');
          await shows('Settings');
          await shows('Kilo Code CLI · GPT-5.5 · via openai');
          await moveCursorTo(text, write, '\x1b[B', /▌ BUILD/);
          write('\r');
          await shows('BUILD · tool, model, effort');
          if (held) {
            await shows(/▌ GPT-5\.5/);
            writeFileSync(listingGate, '');
          }
          // The picker opens on the seat's effort row when Kilo's listing landed first, and on
          // the seat's model row when it lands after.
          await shows(/├─ github-copilot +signed in/, 30_000);
          await shows(
            held ? /▌ GPT-5\.5 +2 providers/ : /▌ (GPT-5\.5 +2 providers|[│ ] +└─ effort)/,
          );
          await steps({ projectDir, text, write, shows });
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
}

const LISTINGS = [
  { name: "Kilo's listing answers at once", held: false },
  { name: "Kilo's listing lands after the picker opens", held: true },
];

describe('e2e: a Kilo Code seat names the route it runs through', { timeout: 120_000 }, () => {
  describe.for(LISTINGS)('$name', ({ held }) => {
    it('reads via github-copilot in Settings after the BUILD seat moves to the Copilot route', async (context) => {
      await onBuildPicker(context, held, async ({ projectDir, text, write, shows }) => {
        // Both start rows go through the model row.
        await moveCursorTo(text, write, '\x1b[A', /▌ GPT-5\.5 +2 providers/);
        await moveCursorTo(text, write, '\x1b[B', /▌ ├─ github-copilot/);
        write('\r');

        await shows('Kilo Code CLI · GPT-5.5 · via github-copilot');
        expect(text()).not.toContain('Kilo Code CLI · GPT-5.5 · via openai');
        expect(readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8')).toContain(
          'model: github-copilot/gpt-5.5',
        );
      });
    });

    it('keeps the BUILD seat on its own route when Enter takes the row the picker opens on', async (context) => {
      await onBuildPicker(context, held, async ({ projectDir, text, write, shows }) => {
        write('\r');

        await shows('Saved BUILD · Kilo Code CLI · GPT-5.5 · via openai');
        // The picker saved the seat and closed: Settings holds the cursor on the BUILD row again.
        await vi.waitFor(
          () => {
            expect(text()).not.toContain('BUILD · tool, model, effort');
            expect(text()).toMatch(/▌ BUILD +Kilo Code CLI · GPT-5\.5 · via /);
          },
          { timeout: 10_000 },
        );
        expect(text()).toContain('Kilo Code CLI · GPT-5.5 · via openai');
        expect(text()).not.toContain('via github-copilot');
        expect(readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8')).toContain(
          'model: openai/gpt-5.5',
        );
      });
    });
  });
});
