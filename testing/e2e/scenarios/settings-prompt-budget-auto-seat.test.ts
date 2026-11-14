import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

const VIEWPORT = { cols: 120, rows: 40 };
// `kilo auth list` on kilo 7.0.49: a Copilot sign-in and an OpenAI key.
const AUTH_LIST =
  '┌  Credentials ~/.local/share/kilo/auth.json\n│\n●  GitHub Copilot oauth\n│\n└  1 credentials\n\n┌  Environment\n│\n●  OpenAI OPENAI_API_KEY\n│\n└  1 environment variables\n';
// Two rows of a real `kilo models --verbose` listing of 321 rows: its smallest window and a 1M
// model, cut to the fields SPLITBRIEF reads.
const KILO_ROWS = [
  {
    id: 'openai/gpt-3.5-turbo-0613',
    providerID: 'kilo',
    name: 'OpenAI: GPT-3.5 Turbo (older v0613)',
    family: 'gpt',
    limit: { context: 4095, output: 3685 },
    capabilities: { toolcall: true, input: { text: true, image: false }, output: { text: true } },
  },
  {
    id: '~anthropic/claude-fable-latest',
    providerID: 'kilo',
    name: 'Anthropic: Claude Fable Latest ($$$$)',
    family: 'claude',
    limit: { context: 1_000_000, output: 128_000 },
    capabilities: { toolcall: true, input: { text: true, image: true }, output: { text: true } },
  },
];
const MODELS_VERBOSE = KILO_ROWS.map(
  (row) => `kilo/${row.id}\n${JSON.stringify(row, null, 2)}\n`,
).join('');

type Screen = Readonly<{
  text: () => string;
  write: (keys: string) => void;
  shows: (expected: string | RegExp, timeout?: number) => Promise<unknown>;
}>;

/** Boots the TUI on an `auto` Kilo Code build seat, then hands the screen over. */
async function withAutoKiloSeat(
  input: Readonly<{
    prefix: string;
    /** The model Kilo Code selects on this machine; absent, Kilo Code keeps no selection file. */
    selectedModel?: Readonly<{ providerID: string; modelID: string }>;
    steps: (screen: Screen, projectDir: string) => Promise<void>;
  }>,
): Promise<string | undefined> {
  return withTempDir(input.prefix, async (dir) => {
    const home = join(dir, 'home');
    const stateHome = join(dir, 'state');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const kiloData = join(home, '.local', 'share', 'kilo');
    mkdirSync(kiloData, { recursive: true });
    writeFileSync(join(kiloData, 'auth.json'), '{"github-copilot":{"type":"oauth"}}\n');
    if (input.selectedModel !== undefined) {
      // Kilo Code keeps its picker history under XDG_STATE_HOME, the last selection first.
      mkdirSync(join(stateHome, 'kilo'), { recursive: true });
      writeFileSync(
        join(stateHome, 'kilo', 'model.json'),
        `${JSON.stringify({ recent: [input.selectedModel] })}\n`,
      );
    }
    const runnerPath = join(dir, 'runner.mjs');
    writeFileSync(
      runnerPath,
      "throw new Error('No workflow may start in the prompt budget E2E');\n",
    );
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
        implementer: { kind: 'cli', tool: 'kilo-code', model: 'auto' },
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
  process.stdout.write(${JSON.stringify(MODELS_VERBOSE)});
  process.exit(0);
}
process.exit(1);`,
    );
    const offlinePath = join(dir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('Offline prompt budget E2E'); };\n",
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
        const write = (keys: string) => child.write(keys);
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

/** Opens Settings and filters it to the build seat's prompt budget, the way a user does. */
async function openPromptBudget(screen: Screen): Promise<void> {
  screen.write('/settings');
  await screen.shows('▌ /settings  Crew, fallback, validation, workflow');
  screen.write('\r');
  await screen.shows('Settings');
  screen.write('context');
  await screen.shows(/Prompt budget +auto/);
}

describe('e2e: Settings reads the prompt budget of an auto build seat', {
  timeout: 120_000,
}, () => {
  it('reads the window of the model Kilo Code selects once its listing lands', async (context) => {
    const skipped = await withAutoKiloSeat({
      prefix: 'prompt-budget-auto-selected',
      selectedModel: { providerID: 'kilo', modelID: '~anthropic/claude-fable-latest' },
      steps: async (screen) => {
        await openPromptBudget(screen);
        await screen.shows(/Prompt budget +auto \(1M\)/, 30_000);
        expect(screen.text()).not.toContain('auto (4K)');
      },
    });
    if (skipped !== undefined) context.skip(skipped);
  });

  it('does not budget the smallest listed window when Kilo Code keeps no selection', async (context) => {
    const skipped = await withAutoKiloSeat({
      prefix: 'prompt-budget-auto-unread',
      steps: async (screen, projectDir) => {
        // Boot writes this file once the listing lands. A window read from the listing alone is
        // stored before this write, so the row below reads the settled value.
        await vi.waitFor(
          () =>
            expect(existsSync(join(projectDir, '.splitbrief', 'detection-cache.json'))).toBe(true),
          { timeout: 30_000 },
        );
        await openPromptBudget(screen);
        const row = screen
          .text()
          .split('\n')
          .find((line) => /Prompt budget +auto/.test(line));
        expect(row).toMatch(/Prompt budget +auto\b/);
        expect(row).not.toContain('auto (');
      },
    });
    if (skipped !== undefined) context.skip(skipped);
  });
});
