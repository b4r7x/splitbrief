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

const CUSTOM_MODEL = 'anthropic/claude-haiku-4-5';
const SIGN_IN_COMMAND = 'opencode auth login anthropic';
const CUSTOM_SIGN_IN = `OpenCode CLI has no credential for anthropic — run ${SIGN_IN_COMMAND} before start`;
const LONG_DRAFT =
  'Keep the receiving flow as it is, but make the scanner screen show the last three pallets with their weights and the time each one was scanned. Read docs/specs/receiving/scanner-screen.md before you start, and do not change the label printer.';

describe('e2e: a save from the home BUILD picker', { timeout: 120_000 }, () => {
  it.for([
    { cols: 120, rows: 40, draft: null },
    { cols: 80, rows: 24, draft: null },
    { cols: 60, rows: 18, draft: LONG_DRAFT },
  ])(
    'shows the sign-in command of a custom model on home at $cols columns',
    async ({ draft, ...viewport }, context) => {
      await withTempDir('home-save-sign-in', async (dir) => {
        const home = join(dir, 'home');
        const projectDir = join(dir, 'project');
        const binDir = join(dir, 'bin');
        mkdirSync(binDir);
        mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
        mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
        writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        const opencodeData = join(home, '.local', 'share', 'opencode');
        mkdirSync(opencodeData, { recursive: true });
        writeFileSync(join(opencodeData, 'auth.json'), '{"deepseek":{"type":"api"}}\n');
        const runnerPath = join(dir, 'runner.mjs');
        writeFileSync(
          runnerPath,
          "throw new Error('No workflow may start in the home save E2E');\n",
        );
        writeConfig(
          projectDir,
          makeConfig({
            planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
            implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
            workflow: { isolation: 'none' },
          }),
        );
        for (const tool of Object.values(CLI_TOOL_CATALOG)) {
          writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
        }
        const authList = [
          { id: 'deepseek', name: 'DeepSeek', connections: [{ type: 'credential' }] },
        ];
        const served = { id: 'deepseek-flash', providerID: 'deepseek' };
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
  console.log(${JSON.stringify(JSON.stringify({ data: [served] }))});
  process.exit(0);
}
process.exit(1);`,
        );
        const offlinePath = join(dir, 'offline.mjs');
        writeFileSync(
          offlinePath,
          "globalThis.fetch = async () => { throw new Error('Offline home save E2E'); };\n",
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
            const lines = () =>
              Array.from(
                { length: viewport.rows },
                (_, row) =>
                  terminal.buffer.active
                    .getLine(terminal.buffer.active.viewportY + row)
                    ?.translateToString(true) ?? '',
              );
            const text = () => lines().join('\n');
            const shows = (expected: string | RegExp, timeout = 10_000) =>
              vi.waitFor(
                () =>
                  typeof expected === 'string'
                    ? expect(text()).toContain(expected)
                    : expect(text()).toMatch(expected),
                { timeout },
              );
            const moveTo = async (key: string, row: RegExp) => {
              for (let step = 0; step < 5 && !row.test(text()); step++) {
                child.write(key);
                await delay(200);
              }
              await shows(row);
            };
            const dataListener = child.onData((data) => terminal.write(data));
            const exitListener = child.onExit((event) => {
              didExit = true;
              exited.resolve(event);
            });
            try {
              await shows('Describe your feature', 30_000);
              await delay(PROMPT_TYPEAHEAD_GRACE_MS);

              child.write('/crew build');
              await shows('/crew build');
              child.write('\r');
              await shows('BUILD · tool, model, effort');
              await shows('DeepSeek V4.1', 30_000);
              child.write('\x1b[C');
              await shows(/▌ DeepSeek V4\.1/);
              await moveTo('\x1b[A', /▌ \+ Add custom model…/);
              child.write('\r');
              await shows('Model id for OpenCode CLI');
              child.write(CUSTOM_MODEL);
              await shows(`› ${CUSTOM_MODEL}`);
              child.write('\r');

              await shows(SIGN_IN_COMMAND);
              const rows = lines();
              const messageEnd = rows.findIndex((row) => row.includes('before start'));
              const message = rows
                .slice(
                  rows.findIndex((row) => row.includes('Saved BUILD')),
                  messageEnd + 1,
                )
                .map((row) => row.trim())
                .join(' ');
              expect(message).toContain(`Saved BUILD · OpenCode CLI`);
              expect(message).toContain(CUSTOM_SIGN_IN);
              expect(rows[messageEnd + 1]).toContain('╭');
              expect(text()).not.toContain('BUILD · tool, model, effort');
              expect(
                readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8'),
              ).toContain(`model: ${CUSTOM_MODEL}`);

              if (draft !== null) {
                for (let start = 0; start < draft.length; start += 40) {
                  child.write(draft.slice(start, start + 40));
                  await delay(30);
                }
                await shows('printer.');
                expect(text()).toContain('before start');
                expect(text()).toContain('/crew to change');
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
