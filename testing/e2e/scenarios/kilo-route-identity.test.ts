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
const MODELS_VERBOSE = fileURLToPath(
  new URL('../../fixtures/kilo/models-verbose.txt', import.meta.url),
);
// `kilo auth list` on kilo 7.0.49: a Copilot sign-in and an OpenAI key.
const AUTH_LIST =
  '┌  Credentials ~/.local/share/kilo/auth.json\n│\n●  GitHub Copilot oauth\n│\n└  1 credentials\n\n┌  Environment\n│\n●  OpenAI OPENAI_API_KEY\n│\n└  1 environment variables\n';

/** Moves the cursor with `key` until the row matching `row` holds it. */
async function moveTo(
  text: () => string,
  write: (keys: string) => void,
  key: string,
  row: RegExp,
): Promise<void> {
  for (let step = 0; step < 8 && !row.test(text()); step++) {
    write(key);
    await delay(200);
  }
  await vi.waitFor(() => expect(text()).toMatch(row), { timeout: 10_000 });
}

describe('e2e: a Kilo Code seat names the route it runs through', { timeout: 120_000 }, () => {
  it('reads via github-copilot in Settings after the BUILD seat moves to the Copilot route', async (context) => {
    await withTempDir('kilo-route-identity', async (dir) => {
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
      writeFileSync(
        runnerPath,
        "throw new Error('No workflow may start in the Kilo route E2E');\n",
      );
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
  process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(MODELS_VERBOSE)}, 'utf8'));
  process.exit(0);
}
process.exit(1);`,
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
          const dataListener = child.onData((data) => terminal.write(data));
          const exitListener = child.onExit((event) => {
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
            await moveTo(text, write, '\x1b[B', /▌ BUILD/);
            write('\r');
            await shows('BUILD · tool, model, effort');
            // The picker opens on the seat's model, expanded to its routes, once Kilo's listing lands.
            await shows(/├─ github-copilot +signed in/, 30_000);
            await moveTo(text, write, '\x1b[A', /▌ ├─ github-copilot/);
            write('\r');

            await shows('Kilo Code CLI · GPT-5.5 · via github-copilot');
            expect(text()).not.toContain('Kilo Code CLI · GPT-5.5 · via openai');
            expect(readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8')).toContain(
              'model: github-copilot/gpt-5.5',
            );
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
  });
});
