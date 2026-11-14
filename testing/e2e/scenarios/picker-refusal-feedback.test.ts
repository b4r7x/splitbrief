import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { resolveTheme } from '../../../src/core/theme/resolve.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { moveCursorTo } from '../helpers/move-cursor.js';
import { readForegroundAtText } from '../helpers/terminal-cells.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

type Viewport = Readonly<{ cols: number; rows: number }>;

const WIDE: Viewport = { cols: 120, rows: 40 };
const NARROW: Viewport = { cols: 50, rows: 40 };
const BUILD_MODEL = 'gpt-6-sol';
const REFUSAL = 'BUILD runs OpenAI Codex CLI · GPT-6-Sol now · choose another tool or model';
const CODEX_MODELS = fileURLToPath(
  new URL('../../fixtures/codex/debug-models-0.155.1.json', import.meta.url),
);
const SCREEN_THEME = resolveTheme({ variant: 'dark', level: 3, terminalBackground: undefined });

type Screen = Readonly<{
  text: () => string;
  write: (keys: string) => void;
  shows: (expected: string | RegExp, timeout?: number) => Promise<unknown>;
  foregroundAt: (phrase: string) => ReturnType<typeof readForegroundAtText>;
}>;

async function withCodexHome(
  viewport: Viewport,
  drive: (screen: Screen, configPath: string) => Promise<void>,
) {
  return withTempDir('picker-refusal-feedback', async (dir) => {
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    mkdirSync(home);
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":{"refresh_token":"e2e"}}\n');
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const runnerPath = join(dir, 'runner.mjs');
    writeFileSync(runnerPath, "throw new Error('No workflow may start in the refusal E2E');\n");
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
        implementer: { kind: 'cli', tool: 'codex', model: BUILD_MODEL },
        workflow: { isolation: 'none' },
      }),
    );
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
    }
    writeFakeNodeCli(
      binDir,
      CLI_TOOL_CATALOG.codex.command,
      `const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args === '--version') {
  console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}');
  process.exit(0);
}
if (args === 'login status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (args.startsWith('debug models')) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(CODEX_MODELS)}, 'utf8'));
  process.exit(0);
}
process.exit(1);`,
    );
    const offlinePath = join(dir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('Offline refusal E2E'); };\n",
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
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          didExit = true;
          exited.resolve(event);
        });
        const screen: Screen = {
          text,
          write: (keys) => child.write(keys),
          shows: (expected, timeout = 10_000) =>
            vi.waitFor(
              () =>
                typeof expected === 'string'
                  ? expect(text()).toContain(expected)
                  : expect(text()).toMatch(expected),
              { timeout },
            ),
          foregroundAt: (phrase) => readForegroundAtText(terminal.buffer.active, phrase),
        };
        try {
          await screen.shows('Describe your feature', 30_000);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          await drive(screen, join(projectDir, '.splitbrief', 'config.yaml'));
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

describe('e2e: the BUILD fallback picker refuses its own seat', { timeout: 120_000 }, () => {
  it('shows the neutral refusal in the byline and saves nothing', async (context) => {
    const skipped = await withCodexHome(WIDE, async (screen, configPath) => {
      screen.write('/crew');
      await screen.shows('▌ /crew  Who fills each seat');
      screen.write('\r');
      await screen.shows('Settings');
      await moveCursorTo(screen.text, screen.write, '\x1b[B', /▌ BUILD.*none/);
      const configBefore = readFileSync(configPath, 'utf8');

      screen.write('\r');
      await screen.shows('BUILD fallback · tool, model, effort');
      screen.write('codex');
      await screen.shows(/▌ OpenAI Codex CLI/);
      await screen.shows('GPT-6-Luna', 30_000);
      screen.write('\x1b[C');
      await screen.shows(/▌[\s\S]*▌/);
      screen.write('gpt-6-sol');
      await screen.shows('› gpt-6-sol');
      await screen.shows('GPT-6-Sol · gpt-6-sol');
      screen.write('\r');
      await screen.shows(/▌.*─ effort/);
      screen.write('\r');

      await screen.shows(REFUSAL);
      expect(screen.foregroundAt('choose another tool or model')).toEqual({
        mode: 'rgb',
        color: SCREEN_THEME.textDim,
      });
      expect(screen.text()).toContain('BUILD fallback · tool, model, effort');
      expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
    });
    if (skipped !== undefined) context.skip(skipped);
  });

  it('shows the neutral refusal in a terminal of 50 columns and saves nothing', async (context) => {
    const skipped = await withCodexHome(NARROW, async (screen, configPath) => {
      screen.write('/crew');
      await screen.shows('▌ /crew  Who fills each seat');
      screen.write('\r');
      await screen.shows('Settings');
      await moveCursorTo(screen.text, screen.write, '\x1b[B', /▌ BUILD.*none/);
      const configBefore = readFileSync(configPath, 'utf8');

      screen.write('\r');
      await screen.shows('BUILD fallback · tool, model, effort');
      screen.write('codex');
      await screen.shows(/▌ OpenAI…/);
      await screen.shows('GPT-6-Luna', 30_000);
      screen.write('\x1b[C');
      await screen.shows(/▌[\s\S]*▌/);
      screen.write('gpt-6-sol');
      await screen.shows('› gpt-6-sol');
      await screen.shows(/▌ GPT-6-Sol/);
      screen.write('\r');
      await screen.shows(/▌.*─ effort/);
      screen.write('\r');

      await screen.shows('choose another tool or model');
      expect(screen.text()).toContain('BUILD runs OpenAI Codex CLI · GPT-6-Sol now');
      expect(screen.foregroundAt('choose another tool or model')).toEqual({
        mode: 'rgb',
        color: SCREEN_THEME.textDim,
      });
      expect(screen.text()).toContain('BUILD fallback · tool, model, effort');
      expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
    });
    if (skipped !== undefined) context.skip(skipped);
  });
});
