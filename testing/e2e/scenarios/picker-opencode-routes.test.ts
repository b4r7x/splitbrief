import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
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
  readonly write: (keys: string) => void;
  readonly shows: (expected: string | RegExp, timeout?: number) => Promise<void>;
};

/** Opens SPLITBRIEF home in a PTY on a project whose BUILD seat is OpenCode, then runs `drive`. */
async function withOpencodeHome(
  label: string,
  account: OpencodeAccount,
  drive: (screen: Screen, projectDir: string) => Promise<void>,
  skip: (reason: string) => void,
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
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          didExit = true;
          exited.resolve(event);
        });
        const prose = () =>
          text()
            .split('\n')
            .map((line) => line.replace(/[│╭╮╰╯─]/g, ' ').trim())
            .filter((line) => line !== '')
            .join(' ')
            .replace(/ +/g, ' ');
        const screen: Screen = {
          text,
          prose,
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

/** Moves the model column's cursor with `key` until the row matching `row` holds it. */
async function moveTo(screen: Screen, key: string, row: RegExp): Promise<void> {
  for (let step = 0; step < 5 && !row.test(screen.text()); step++) {
    screen.write(key);
    await delay(200);
  }
  await screen.shows(row);
}

const CUSTOM_MODEL = 'anthropic/claude-haiku-4-5';
const CUSTOM_SIGN_IN =
  'OpenCode CLI has no credential for anthropic — run opencode auth login anthropic before start';

describe('e2e: the BUILD picker on an OpenCode seat', { timeout: 120_000 }, () => {
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

  it('adds the sign-in step to the save message of a custom model on a provider with no credential', async (context) => {
    await withOpencodeHome(
      'picker-custom-model-sign-in',
      {
        signedIn: { id: 'deepseek', name: 'DeepSeek' },
        served: { id: 'deepseek-flash', providerID: 'deepseek' },
        buildModel: 'deepseek/deepseek-flash',
      },
      async (screen, projectDir) => {
        // Settings shows the whole save message.
        screen.write('/crew');
        await screen.shows('▌ /crew  Who fills each seat');
        screen.write('\r');
        await screen.shows('Settings');
        await moveTo(screen, '\x1b[B', /▌ BUILD/);
        screen.write('\r');
        await screen.shows('BUILD · tool, model, effort');
        await screen.shows('DeepSeek V4.1 Flash', 30_000);
        screen.write('\x1b[C');
        await screen.shows(/▌ DeepSeek V4\.1 Flash/);
        await moveTo(screen, '\x1b[A', /▌ \+ Add custom model…/);
        screen.write('\r');
        await screen.shows('Model id for OpenCode CLI');
        screen.write(CUSTOM_MODEL);
        await screen.shows(`› ${CUSTOM_MODEL}`);
        screen.write('\r');

        await vi.waitFor(() => expect(screen.prose()).toContain(CUSTOM_SIGN_IN), {
          timeout: 10_000,
        });
        expect(screen.prose()).toContain('Saved BUILD · OpenCode CLI');
        expect(readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8')).toContain(
          `model: ${CUSTOM_MODEL}`,
        );
      },
      (reason) => context.skip(reason),
    );
  });
});
