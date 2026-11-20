import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { acrossNoticeEdges } from '#testing/helpers/notice-text.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { moveCursorTo } from '../helpers/move-cursor.js';
import { terminalCellAtText } from '../helpers/terminal-cells.js';
import { wholeFrames } from '../helpers/whole-frames.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

const VIEWPORT = { cols: 120, rows: 40 };

interface OpencodeAccount {
  /** What `opencode auth list --format json` prints for the one signed-in provider. */
  readonly signedIn: { readonly id: string; readonly name: string };
  /** The one model `opencode api GET /api/model` serves. */
  readonly served: {
    readonly id: string;
    readonly providerID: string;
    readonly variants?: readonly { readonly id: string }[];
  };
  /** The BUILD seat's saved OpenCode model. */
  readonly buildModel: string;
}

type Screen = {
  readonly text: () => string;
  /** The screen as one line: box borders dropped and wrapped rows joined, so a wrapped sentence reads whole. */
  readonly prose: () => string;
  readonly background: (phrase: string, offset?: number) => number | undefined;
  readonly resize: (cols: number, rows: number) => void;
  readonly write: (keys: string) => void;
  readonly shows: (expected: string | RegExp, timeout?: number) => Promise<void>;
};

/** Opens SPLITBRIEF home in a PTY on a project whose BUILD seat is OpenCode, then runs `drive`. */
async function withOpencodeHome(
  label: string,
  account: OpencodeAccount,
  drive: (screen: Screen, projectDir: string) => Promise<void>,
  skip: (reason: string) => void,
  viewport = VIEWPORT,
): Promise<void> {
  await withTempDir(label, async (dir) => {
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const opencodeData = join(home, '.local', 'share', 'opencode');
    mkdirSync(opencodeData, { recursive: true });
    writeFileSync(
      join(opencodeData, 'auth.json'),
      `${JSON.stringify({ [account.signedIn.id]: { type: 'api' } })}\n`,
    );
    const runnerPath = join(dir, 'runner.mjs');
    writeFileSync(runnerPath, "throw new Error('No workflow may start in the picker E2E');\n");
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
        implementer: { kind: 'cli', tool: 'opencode', model: account.buildModel },
        workflow: { isolation: 'none' },
      }),
    );
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
    }
    const authList = [{ ...account.signedIn, connections: [{ type: 'credential' }] }];
    writeFakeNodeCli(
      binDir,
      'opencode',
      `const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  console.log(${JSON.stringify(JSON.stringify(authList))});
  process.exit(0);
}
if (args.slice(0, 3).join(' ') === 'api GET /api/model') {
  console.log(${JSON.stringify(JSON.stringify({ data: [account.served] }))});
  process.exit(0);
}
process.exit(1);`,
    );
    const offlinePath = join(dir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('Offline picker E2E'); };\n",
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
            { length: terminal.rows },
            (_, row) =>
              terminal.buffer.active
                .getLine(terminal.buffer.active.viewportY + row)
                ?.translateToString(true) ?? '',
          ).join('\n');
        const frames = wholeFrames((data) => terminal.write(data));
        const dataListener = child.onData(frames.feed);
        const exitListener = child.onExit((event) => {
          frames.flush();
          didExit = true;
          exited.resolve(event);
        });
        const prose = () =>
          acrossNoticeEdges(
            text()
              .split('\n')
              .map((line) => line.replace(/[╭╮╰╯─]/g, ' '))
              .join(' '),
          ).trim();
        const screen: Screen = {
          text,
          prose,
          background: (phrase, offset = 0) => {
            const cell = terminalCellAtText(terminal.buffer.active, phrase, offset);
            if (cell.isBgDefault()) return undefined;
            expect(cell.isBgRGB()).toBe(true);
            return cell.getBgColor();
          },
          resize: (cols, rows) => {
            if (!('resize' in child) || typeof child.resize !== 'function') {
              throw new Error('The PTY does not support resize');
            }
            terminal.resize(cols, rows);
            child.resize(cols, rows);
          },
          write: (keys) => child.write(keys),
          shows: (expected, timeout = 10_000) =>
            vi.waitFor(
              () =>
                typeof expected === 'string'
                  ? expect(text()).toContain(expected)
                  : expect(text()).toMatch(expected),
              { timeout },
            ),
        };
        try {
          await screen.shows('Describe your feature', 30_000);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          await drive(screen, projectDir);
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
    if (result) skip(result.reason);
  });
}

const CUSTOM_MODEL = 'anthropic/claude-haiku-4-5';
const CUSTOM_SIGN_IN =
  'OpenCode CLI has no credential for anthropic — run opencode auth login anthropic before start';

/** Opens the BUILD picker from Settings and moves to its model column. */
async function openBuildPicker(screen: Screen): Promise<void> {
  await moveCursorTo(screen.text, screen.write, '\x1b[B', /▌ BUILD/);
  screen.write('\r');
  await screen.shows('BUILD · tool, model, effort');
  // Only the landed listing names this row alone: the bundled list adds ` · id` to its two
  // DeepSeek rows.
  await screen.shows(/DeepSeek V4\.1(?! Flash ·)/, 30_000);
  screen.write('\x1b[C');
}

/** Saves `CUSTOM_MODEL` on the BUILD seat through the picker's custom-model form. */
async function addCustomModel(screen: Screen): Promise<void> {
  // Settings shows the whole save message.
  screen.write('/crew');
  await screen.shows('▌ /crew  Who fills each seat');
  screen.write('\r');
  await screen.shows('Settings');
  await openBuildPicker(screen);
  await screen.shows(/▌ DeepSeek V4\.1 Flash/);
  await moveCursorTo(screen.text, screen.write, '\x1b[A', /▌ \+ Add custom model…/);
  screen.write('\r');
  await screen.shows('Model id for OpenCode CLI');
  screen.write(CUSTOM_MODEL);
  await screen.shows(`› ${CUSTOM_MODEL}`);
  screen.write('\r');
}

describe('e2e: the BUILD picker on an OpenCode seat', { timeout: 120_000 }, () => {
  it('shows full tool names and their status in the 80-column picker', async (context) => {
    await withOpencodeHome(
      'picker-full-tool-name',
      {
        signedIn: { id: 'deepseek', name: 'DeepSeek' },
        served: { id: 'deepseek-flash', providerID: 'deepseek' },
        buildModel: 'deepseek/deepseek-flash',
      },
      async (screen) => {
        screen.write('/crew build');
        await screen.shows('/crew build');
        screen.write('\r');
        await screen.shows('BUILD · tool, model, effort');
        screen.write('\x1b[D');
        await screen.shows(/▌ OpenCode CLI/u);
        screen.write('antigravity');
        await screen.shows(/› antigravity/u);
        await screen.shows(/▌ Google/u);
        const tool = screen
          .text()
          .split('\n')
          .find((row) => row.includes('▌ Google'));
        expect(tool).toMatch(
          /▌ Google Antigravity CLI +(?:Unavailable|Unverified|Incompatible|Untrusted|Disabled|Needs sign-in)\b/u,
        );
      },
      (reason) => context.skip(reason),
      { cols: 80, rows: 24 },
    );
  });

  it('uses the completion background inside Settings and fills its active row', async (context) => {
    await withOpencodeHome(
      'settings-overlay-color',
      {
        signedIn: { id: 'deepseek', name: 'DeepSeek' },
        served: { id: 'deepseek-flash', providerID: 'deepseek' },
        buildModel: 'deepseek/deepseek-flash',
      },
      async (screen) => {
        screen.write('/crew');
        await screen.shows('▌ /crew  Who fills each seat');
        const panel = screen.background('tab fill');
        const active = screen.background('▌ /crew');
        expect(panel).toBeDefined();
        expect(active).toBeDefined();
        expect(active).not.toBe(panel);

        screen.write('\r');
        await screen.shows('│  Settings');
        const title = ' │  Settings';
        expect(screen.background(title)).toBeUndefined();
        expect(screen.background(title, 2)).toBe(panel);
        expect(screen.background('Settings')).toBe(panel);
        const lead = '▌ PLAN';
        expect(screen.background(lead)).toBe(active);
        expect(screen.background(lead, 1)).toBe(active);

        screen.write('\x1b[B');
        await screen.shows('▌ BUILD');
        expect(screen.background('▌ BUILD')).toBe(active);
        expect(screen.background('PLAN ')).toBe(panel);
      },
      (reason) => context.skip(reason),
    );
  });

  it('keeps the model filter when resizing across the single-pane breakpoint', async (context) => {
    await withOpencodeHome(
      'picker-single-pane',
      {
        signedIn: { id: 'deepseek', name: 'DeepSeek' },
        served: { id: 'deepseek-flash', providerID: 'deepseek' },
        buildModel: 'deepseek/deepseek-flash',
      },
      async (screen, projectDir) => {
        const path = join(projectDir, '.splitbrief', 'config.yaml');
        const before = readFileSync(path, 'utf8');
        screen.write('/crew build');
        await screen.shows('/crew build');
        screen.write('\r');
        await screen.shows('▌ OpenCode CLI', 30_000);
        const columns = /│\s*Tools\s*│.*│\s*Models\s*│/;
        expect(screen.text()).not.toMatch(columns);

        screen.write('opencode');
        await screen.shows('› opencode');
        const lines = screen.text().split('\n');
        const row = lines.findIndex((line) => line.includes('▌ OpenCode CLI'));
        const column = lines[row]?.indexOf('OpenCode CLI') ?? -1;
        expect(column).toBeGreaterThan(0);
        screen.write(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
        await screen.shows(/▌ DeepSeek V4\.1 Flash/, 30_000);
        screen.write('deepseek');
        await screen.shows('› deepseek');
        expect(screen.text()).not.toContain('› opencode');

        screen.resize(120, 24);
        await screen.shows(columns);
        const filters = screen
          .text()
          .split('\n')
          .find((line) => line.includes('› deepseek'));
        expect(filters).toContain('  opencode');
        expect(filters).not.toContain('› opencode');
        expect(screen.text()).toMatch(/▌ DeepSeek V4\.1 Flash/);
        screen.resize(80, 24);
        await vi.waitFor(() => {
          expect(screen.text()).not.toMatch(columns);
          expect(screen.text()).toContain('› deepseek');
          expect(screen.text()).toMatch(/▌ DeepSeek V4\.1 Flash/);
        });
        screen.write('\x1b[D');
        await screen.shows('› opencode');
        expect(screen.text()).not.toContain('› deepseek');
        expect(readFileSync(path, 'utf8')).toBe(before);
      },
      (reason) => context.skip(reason),
      { cols: 80, rows: 24 },
    );
  });

  it('keeps a custom model row when the filter holds the name the row shows', async (context) => {
    await withOpencodeHome(
      'picker-custom-model-filter',
      {
        signedIn: { id: 'deepseek', name: 'DeepSeek' },
        served: { id: 'deepseek-flash', providerID: 'deepseek' },
        buildModel: 'deepseek/deepseek-flash',
      },
      async (screen) => {
        await addCustomModel(screen);
        await vi.waitFor(() => expect(screen.prose()).toContain('Saved BUILD · OpenCode CLI'), {
          timeout: 10_000,
        });
        await openBuildPicker(screen);
        await screen.shows(/▌ Claude Haiku 4\.5/);
        screen.write('Claude Haiku 4.5');
        await screen.shows('› Claude Haiku 4.5');

        // The row stays in the Models box, not only in the byline under it.
        const modelRows = screen
          .text()
          .split('\n')
          .filter((line) => line.includes('│') && !line.includes('›'));
        expect(modelRows.some((line) => line.includes('Claude Haiku 4.5'))).toBe(true);
      },
      (reason) => context.skip(reason),
    );
  });

  it('lists a custom model only under the tool it was added for', async (context) => {
    await withOpencodeHome(
      'picker-custom-model-other-tool',
      {
        signedIn: { id: 'deepseek', name: 'DeepSeek' },
        served: { id: 'deepseek-flash', providerID: 'deepseek' },
        buildModel: 'deepseek/deepseek-flash',
      },
      async (screen) => {
        await addCustomModel(screen);
        await vi.waitFor(() => expect(screen.prose()).toContain('Saved BUILD · OpenCode CLI'), {
          timeout: 10_000,
        });
        await openBuildPicker(screen);
        await screen.shows(/▌ Claude Haiku 4\.5 +Custom/);

        // The Models cursor leaves its row once the Tools column holds the keys.
        screen.write('\x1b[D');
        await vi.waitFor(() => expect(screen.text()).not.toMatch(/▌ Claude Haiku 4\.5/), {
          timeout: 10_000,
        });
        screen.write('antigravity');
        await screen.shows(/▌ Google Antigravity CLI/);
        await screen.shows('Its models show here when it is ready.');
        // The byline under the picker may still hold the note of the save; the columns may not.
        const columns = screen
          .text()
          .split('\n')
          .filter((line) => line.includes('│'))
          .join('\n');
        expect(columns).not.toContain('Claude Haiku 4.5');
        expect(columns).not.toContain('Custom');
      },
      (reason) => context.skip(reason),
    );
  });

  it('collapses the expanded row on esc and keeps the query typed in the Models column', async (context) => {
    await withOpencodeHome(
      'picker-filter-expanded-esc',
      {
        signedIn: { id: 'openrouter', name: 'OpenRouter' },
        served: {
          id: 'deepseek/deepseek-v4.1-flash',
          providerID: 'openrouter',
          variants: [{ id: 'low' }, { id: 'high' }],
        },
        buildModel: 'openrouter/deepseek/deepseek-v4.1-flash',
      },
      async (screen, projectDir) => {
        const configPath = join(projectDir, '.splitbrief', 'config.yaml');
        const savedConfig = readFileSync(configPath, 'utf8');
        screen.write('/crew build');
        await screen.shows('/crew build');
        screen.write('\r');
        await screen.shows('BUILD · tool, model, effort');
        await screen.shows(/DeepSeek V4\.1 Flash +▾/, 30_000);
        screen.write('\x1b[C');
        await screen.shows(/▌ DeepSeek V4\.1 Flash/);
        screen.write('deepseek');
        await screen.shows('› deepseek');
        await screen.shows(/▌ DeepSeek V4\.1 Flash/);
        screen.write('\r');
        await screen.shows(/└─ openrouter/);
        await screen.shows('esc collapse');

        screen.write('\x1b');
        await vi.waitFor(() => expect(screen.text()).not.toMatch(/└─ openrouter/), {
          timeout: 10_000,
        });
        expect(screen.text()).toContain('› deepseek');
        expect(screen.text()).toMatch(/▌ DeepSeek V4\.1 Flash/);
        expect(screen.text()).toContain('esc clear');

        screen.write('\r');
        await screen.shows(/└─ openrouter/);
        expect(readFileSync(configPath, 'utf8')).toBe(savedConfig);
      },
      (reason) => context.skip(reason),
    );
  });

  it('names an OpenRouter route by the account it runs through, beside that account sign-in', async (context) => {
    await withOpencodeHome(
      'picker-openrouter-route',
      {
        signedIn: { id: 'openrouter', name: 'OpenRouter' },
        served: {
          id: 'deepseek/deepseek-v4.1-flash',
          providerID: 'openrouter',
          variants: [{ id: 'low' }, { id: 'high' }],
        },
        buildModel: 'openrouter/deepseek/deepseek-v4.1-flash',
      },
      async (screen) => {
        screen.write('/crew build');
        await screen.shows('/crew build');
        screen.write('\r');
        await screen.shows('BUILD · tool, model, effort');
        // The row expands once OpenCode's listing lands with the model's effort levels.
        await screen.shows(/DeepSeek V4\.1 Flash +▾/, 30_000);
        screen.write('\x1b[C');
        await screen.shows(/▌ DeepSeek V4\.1 Flash/);
        screen.write('\r');

        await screen.shows(/└─ openrouter +signed in/);
        expect(screen.text()).not.toMatch(/─ deepseek\b/);
      },
      (reason) => context.skip(reason),
    );
  });

  it('opens the custom-model form when ↑ and ⏎ reach the picker in one read', async (context) => {
    await withOpencodeHome(
      'picker-up-enter-one-read',
      {
        signedIn: { id: 'deepseek', name: 'DeepSeek' },
        served: { id: 'deepseek-flash', providerID: 'deepseek' },
        buildModel: 'deepseek/deepseek-flash',
      },
      async (screen) => {
        screen.write('/crew');
        await screen.shows('▌ /crew  Who fills each seat');
        screen.write('\r');
        await screen.shows('Settings');
        await openBuildPicker(screen);
        await screen.shows(/▌ DeepSeek V4\.1 Flash/);
        await moveCursorTo(screen.text, screen.write, '\x1b[A', /▌ auto/);

        screen.write('\x1b[A\r');
        // The wait ends on either outcome: the row above opens its form, or `auto` is saved.
        await vi.waitFor(
          () =>
            expect(screen.text()).toMatch(/Model id for OpenCode CLI|BUILD +OpenCode CLI · auto/),
          { timeout: 10_000 },
        );
        expect(screen.text()).toContain('Model id for OpenCode CLI');
      },
      (reason) => context.skip(reason),
    );
  });

  it.for([VIEWPORT, { cols: 80, rows: 24 }])(
    'adds the sign-in step to the save message of a custom model on a provider with no credential at $cols columns',
    async (viewport, context) => {
      await withOpencodeHome(
        'picker-custom-model-sign-in',
        {
          signedIn: { id: 'deepseek', name: 'DeepSeek' },
          served: { id: 'deepseek-flash', providerID: 'deepseek' },
          buildModel: 'deepseek/deepseek-flash',
        },
        async (screen, projectDir) => {
          await addCustomModel(screen);

          await vi.waitFor(() => expect(screen.prose()).toContain(CUSTOM_SIGN_IN), {
            timeout: 10_000,
          });
          expect(screen.prose()).toContain('Saved BUILD · OpenCode CLI');
          expect(readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8')).toContain(
            `model: ${CUSTOM_MODEL}`,
          );

          // Every wrapped row of the message starts in the column of its first row.
          const rows = screen.text().split('\n');
          const message = rows.slice(
            rows.findIndex((row) => row.includes('Saved BUILD')),
            rows.findIndex((row) => row.includes('before start')) + 1,
          );
          const indent = (row: string) => row.slice(row.indexOf('│') + 1).search(/\S/);
          expect(message.length).toBeGreaterThan(1);
          expect(message.map(indent)).toEqual(message.map(() => indent(message[0] ?? '')));
          expect(message.some((row) => row.includes('.splitbrief/config.yaml'))).toBe(true);
        },
        (reason) => context.skip(reason),
        viewport,
      );
    },
  );
});
