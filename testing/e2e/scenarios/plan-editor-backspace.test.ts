import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const VIEWPORT = { cols: 160, rows: 40 };
let fixture: StopContinueFixture;
let environment: Readonly<Record<string, string>>;
let offlinePath: string;

beforeEach(async () => {
  fixture = createStopContinueFixture(
    () => "throw new Error('BUILD must not start in the plan editor E2E');\n",
    { isolation: 'none' },
  );
  const home = join(fixture.tmpDir, 'home');
  const bin = join(fixture.tmpDir, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  for (const tool of Object.values(CLI_TOOL_CATALOG)) {
    writeFakeNodeCli(bin, tool.command, 'process.exit(1);');
  }
  environment = safeChildEnvironment(home, [bin]);
  const initial = loadConfig(fixture.projectDir).config;
  const config = {
    ...initial,
    planner: { ...initial.planner, command: process.execPath },
    implementer: { ...initial.implementer, command: process.execPath },
    workflow: { ...initial.workflow, approve: 'plan' as const },
  };
  writeConfig(fixture.projectDir, config);
  await trustDeclaredRunners({
    projectDir: fixture.projectDir,
    config,
    stateDir: join(home, SPLITBRIEF_DIR, 'trust'),
  });
  offlinePath = join(fixture.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('Network disabled in plan editor E2E'); };\n",
  );
});

afterEach(() => cleanupTempDir(fixture.tmpDir));

it('deletes the character before the caret on Backspace in the plan.json editor', async (context) => {
  const result = await runWithPtyChild(
    {
      requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
      argv: [
        '--import',
        'tsx',
        '--import',
        offlinePath,
        'src/cli.ts',
        'start',
        'smoke',
        '--allow-repo-runners',
        '--project',
        fixture.projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        ...VIEWPORT,
        cwd: REPO_ROOT,
        env: { ...environment, XDG_STATE_HOME: fixture.stateHome },
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
      const firstEditorLine = () => screen().match(/^│ (\S*\{)\s*│$/m)?.[1];
      const dataListener = child.onData((data) => terminal.write(data));
      const exitListener = child.onExit((event) => {
        didExit = true;
        exited.resolve(event);
      });
      try {
        await vi.waitFor(() => expect(screen()).toContain('Approve plan and start the build'), {
          timeout: 30_000,
        });
        child.write('e');
        await vi.waitFor(() => expect(screen()).toContain('› e'));
        child.write(PTY_SUBMIT_INPUT);
        await vi.waitFor(() => expect(screen()).toContain('"summary"'), { timeout: 10_000 });

        child.write('AB');
        await vi.waitFor(() => expect(firstEditorLine()).toBe('AB{'));
        child.write('\x1b[D');
        child.write('\x7f');
        await vi.waitFor(() => expect(firstEditorLine(), screen()).toBe('B{'));

        child.write('\x1b');
        await vi.waitFor(() => expect(screen()).toContain('Approve plan and start the build'));
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
