import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../src/core/runners/cli-tool/types.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { seedSignInFile } from '#testing/helpers/sign-in-home.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { moveCursorTo } from '../helpers/move-cursor.js';
import { wholeFrames } from '../helpers/whole-frames.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

const VIEWPORT = { cols: 120, rows: 40 };
const CMD_CACHE = fileURLToPath(
  new URL('../../fixtures/command-code/model-catalog-cache-1.88.5.json', import.meta.url),
);
const CODEX_MODELS = fileURLToPath(
  new URL('../../fixtures/codex/debug-models-0.155.1.json', import.meta.url),
);
// `cmd --list-models` on cmd 1.88.5, cut to two of its rows.
const CMD_LISTING = [
  'Available models  ·  2 models',
  '',
  'Open Source',
  '',
  'deepseek/deepseek-v4.1-flash-fast       High throughput V4.1 Flash',
  '',
  'Anthropic',
  '',
  'claude-haiku-4-5                        prev Haiku, still fast for quick tasks',
  '',
  'Docs:  https://commandcode.ai/docs/reference/cli/models',
  '',
].join('\n');
// `cursor-agent --list-models` on 2026.09.18, from its first line of output.
const CURSOR_LISTING = readFileSync(
  fileURLToPath(new URL('../../fixtures/cursor/list-models-2026.09.18.txt', import.meta.url)),
  'utf8',
).replace(/^[\s\S]*?(?=Available models)/, '');

type Screen = Readonly<{
  text: () => string;
  write: (keys: string) => void;
  shows: (expected: string | RegExp, timeout?: number) => Promise<unknown>;
}>;

type SeatFixture = Readonly<{
  tool: CliToolId;
  model: string;
  prepareHome: (home: string, xdgConfigHome: string | undefined) => void;
  fakeBody: string;
}>;

/** Opens the BUILD seat picker from Settings, the way a user does, then hands the screen over. */
async function inBuildSeatPicker(
  input: SeatFixture &
    Readonly<{
      prefix: string;
      steps: (screen: Screen, projectDir: string) => Promise<void>;
    }>,
): Promise<string | undefined> {
  return withTempDir(input.prefix, async (dir) => {
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    mkdirSync(home);
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const runnerPath = join(dir, 'runner.mjs');
    writeFileSync(
      runnerPath,
      "throw new Error('No workflow may start in the effort picker E2E');\n",
    );
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
        implementer: { kind: 'cli', tool: input.tool, model: input.model },
        workflow: { isolation: 'none' },
      }),
    );
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
    }
    writeFakeNodeCli(binDir, CLI_TOOL_CATALOG[input.tool].command, input.fakeBody);
    const offlinePath = join(dir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('Offline effort picker E2E'); };\n",
    );

    const restorePath = activateSafeCliShimPath(binDir);
    let environment: Readonly<Record<string, string>>;
    try {
      environment = safeChildEnvironment(home, [binDir]);
    } finally {
      restorePath();
    }
    input.prepareHome(home, environment.XDG_CONFIG_HOME);
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
          await moveCursorTo(text, write, '\x1b[B', /▌ BUILD/);
          write('\r');
          await shows('BUILD · tool, model, effort');
          await input.steps({ text, write, shows }, projectDir);
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
}

const SAVED_BUILD = /Saved BUILD · .* to \.splitbrief\/config\.yaml/;

/** A Codex 0.155.1 BUILD seat on `gpt-6-sol`, signed in through ChatGPT. */
const CODEX_SEAT: SeatFixture = {
  tool: 'codex',
  model: 'gpt-6-sol',
  prepareHome: (home) => {
    seedSignInFile(home, 'codex', { contents: '{"tokens":{"refresh_token":"e2e"}}\n' });
  },
  fakeBody: `const args = process.argv.slice(2).join(' ');
if (args === '--version') {
  console.log('codex-cli 0.155.1');
  process.exit(0);
}
if (args === 'login status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (args.startsWith('debug models')) {
  process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(CODEX_MODELS)}, 'utf8'));
  process.exit(0);
}
process.exit(1);`,
};

/** Presses space on the effort row and waits for each level in turn. */
async function cycleEffort(screen: Screen, levels: readonly string[]): Promise<void> {
  await screen.shows(/─ effort +auto\b/);
  await moveCursorTo(screen.text, screen.write, '\x1b[B', /▌.*─ effort/);
  for (const level of levels) {
    screen.write(' ');
    await screen.shows(new RegExp(`─ effort +${level}\\b`));
  }
}

describe('e2e: the seat picker offers the effort levels each model publishes', {
  timeout: 120_000,
}, () => {
  it("names the Command Code DeepSeek row as cmd does and offers only that model's levels", async (context) => {
    const skipped = await inBuildSeatPicker({
      prefix: 'picker-command-code-effort',
      tool: 'command-code',
      model: 'deepseek/deepseek-v4.1-flash-fast',
      prepareHome: (home) => {
        seedSignInFile(home, 'command-code', { contents: '{"apiKey":"e2e-session"}\n' });
      },
      // cmd 1.88.5 writes its catalog cache under HOME while `--list-models` runs.
      fakeBody: `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('1.88.5');
  process.exit(0);
}
if (args[0] === 'status') {
  console.log(JSON.stringify({ authenticated: true }));
  process.exit(0);
}
if (args.includes('--list-models')) {
  const folder = path.join(process.env.HOME, '.commandcode', 'cache', 'model-catalog', 'v1');
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(${JSON.stringify(CMD_CACHE)}, path.join(folder, 'catalog-a813c4ec6551f9c3.json'));
  process.stdout.write(${JSON.stringify(CMD_LISTING)});
  process.exit(0);
}
process.exit(1);`,
      steps: async (screen) => {
        await screen.shows('DeepSeek V4.1 Flash Fast (latest)', 30_000);
        // The ladder is cmd's own for this model: off, low, high, max, and no medium.
        await cycleEffort(screen, ['off', 'low', 'high', 'max', 'auto']);
      },
    });
    if (skipped !== undefined) context.skip(skipped);
  });

  it('offers ultra on a Codex model whose own ladder lists it', async (context) => {
    const skipped = await inBuildSeatPicker({
      ...CODEX_SEAT,
      prefix: 'picker-codex-ultra',
      steps: async (screen) => {
        // GPT-6-Luna comes only from the listing, so its row says the listing has landed.
        await screen.shows('GPT-6-Luna', 30_000);
        await cycleEffort(screen, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'auto']);
      },
    });
    if (skipped !== undefined) context.skip(skipped);
  });
});

describe('e2e: a key burst on the seat picker saves what slow keys save', {
  timeout: 120_000,
}, () => {
  /** Puts the cursor on the collapsed GPT-6-Luna row, runs `press`, and reads the save it makes. */
  async function saveFromLuna(prefix: string, press: (screen: Screen) => Promise<void>) {
    let saved: Readonly<{ line: string | undefined; implementer: unknown }> | undefined;
    const skipped = await inBuildSeatPicker({
      ...CODEX_SEAT,
      prefix,
      steps: async (screen, projectDir) => {
        await screen.shows('GPT-6-Luna', 30_000);
        await moveCursorTo(screen.text, screen.write, '\x1b[B', /▌ GPT-6-Luna/);
        await press(screen);
        await screen.shows(SAVED_BUILD);
        saved = {
          line: screen.text().match(SAVED_BUILD)?.[0],
          implementer: YAML.parse(
            readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8'),
          ).implementer,
        };
      },
    });
    return { skipped, saved };
  }

  it('saves the model when ⏎ ↑ ⏎ reach the picker in one read, as the same keys pressed slowly do', async (context) => {
    const slow = await saveFromLuna('picker-burst-slow', async (screen) => {
      screen.write('\r');
      await screen.shows(/GPT-6-Luna[^\n]*▴[^\n]*\n[^\n]*─ /);
      expect(screen.text()).not.toMatch(/[├└]─ auth/);
      await screen.shows('▌ └─ effort');
      screen.write('\x1b[A');
      await screen.shows(/▌ GPT-6-Luna[^\n]*▴/);
      screen.write('\r');
    });
    if (slow.skipped !== undefined) context.skip(slow.skipped);
    // A picker that drops the last two keys leaves the expansion open, and a sound one shows
    // that same screen on its way to the save, so the wait ends on the save line alone.
    const burst = await saveFromLuna('picker-burst-one-read', async (screen) => {
      screen.write('\r\x1b[A\r');
    });
    if (burst.skipped !== undefined) context.skip(burst.skipped);

    expect(burst.saved).toEqual(slow.saved);
  });
});

describe('e2e: a saved custom model with nothing to open confirms from the crew row', {
  timeout: 120_000,
}, () => {
  it('shows the Cursor row closed and saves it on one ⏎', async (context) => {
    const skipped = await inBuildSeatPicker({
      prefix: 'picker-custom-no-children',
      tool: 'cursor',
      model: 'zz-custom-model',
      prepareHome: (home, xdgConfigHome) => {
        seedSignInFile(home, 'cursor', { xdgConfigHome, contents: '{"accessToken":"e2e"}' });
      },
      fakeBody: `const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(${JSON.stringify(CLI_TOOL_CATALOG.cursor.compatibility.testedVersion)});
  process.exit(0);
}
if (args[0] === 'status') {
  console.log('Logged in as e2e@example.com');
  process.exit(0);
}
if (args.includes('--list-models')) {
  process.stdout.write(${JSON.stringify(CURSOR_LISTING)});
  process.exit(0);
}
process.exit(1);`,
      steps: async (screen) => {
        await screen.shows(/▌ Zz Custom Model/, 30_000);
        const row = screen
          .text()
          .split('\n')
          .find((line) => line.includes('Zz Custom Model'));
        expect(row).not.toContain('▴');
        expect(screen.text()).toContain('⏎ confirm · esc cancel');
        screen.write('\r');
        await screen.shows(SAVED_BUILD);
      },
    });
    if (skipped !== undefined) context.skip(skipped);
  });
});

describe('e2e: a click on a tool that reads Auth required keeps the seat', {
  timeout: 120_000,
}, () => {
  it('saves nothing on ⏎ after the click, and ↓ moves the tool cursor', async (context) => {
    const skipped = await inBuildSeatPicker({
      ...CODEX_SEAT,
      prefix: 'picker-click-not-ready',
      steps: async (screen, projectDir) => {
        await screen.shows('GPT-6-Luna', 30_000);
        await screen.shows(/Command Code CLI +Auth required/);
        const configPath = join(projectDir, '.splitbrief', 'config.yaml');
        const before = YAML.parse(readFileSync(configPath, 'utf8')).implementer;
        const lines = screen.text().split('\n');
        const row = lines.findIndex((line) => line.includes('Command Code CLI'));
        const col = lines[row]?.indexOf('Command Code CLI') ?? -1;
        if (col === -1) throw new Error('No Command Code CLI row on the screen.');
        // SGR mouse reports count from 1: a left press, then its release.
        screen.write(`\x1b[<0;${col + 1};${row + 1}M`);
        screen.write(`\x1b[<0;${col + 1};${row + 1}m`);
        await screen.shows(/▌ Command Code CLI/);
        screen.write('\r');
        screen.write('\x1b[B');
        await screen.shows(/▌ Cursor Agent CLI/);

        expect(screen.text()).not.toMatch(SAVED_BUILD);
        expect(YAML.parse(readFileSync(configPath, 'utf8')).implementer).toEqual(before);
      },
    });
    if (skipped !== undefined) context.skip(skipped);
  });
});
